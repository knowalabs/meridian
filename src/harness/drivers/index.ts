import { runStream, versionOf, type StreamOptions, type StreamResult } from '../../core/exec.js';
import { loadConfig } from '../../core/config.js';
import { CliError, EXIT } from '../../core/errors.js';
import { didYouMean } from '../../core/prompt.js';
import {
  availableProviders,
  CLI_DEFAULT_MODEL,
  PROVIDERS,
  route,
  type ProviderSpec,
} from '../../providers/router.js';
import type { HarnessEventBody } from '../events.js';
import { claudeCodeDriver } from './claude-code.js';
import { codexCliDriver } from './codex-cli.js';
import { geminiCliDriver } from './gemini-cli.js';
import {
  parseVersion,
  type Driver,
  type DriverId,
  type DriverTurn,
  type TurnSummary,
} from './types.js';

export const DRIVERS: Record<DriverId, Driver> = {
  'claude-code': claudeCodeDriver,
  'codex-cli': codexCliDriver,
  'gemini-cli': geminiCliDriver,
};

/** The name `meridian install` knows each agent CLI by. */
export const INSTALL_NAME: Record<DriverId, string> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
};

export function isDriverId(id: string): id is DriverId {
  return id in DRIVERS;
}

/** Router specs for the agent CLIs: binary detection and ranking stay the router's job. */
export function agentSpecs(): ProviderSpec[] {
  return PROVIDERS.filter((p) => isDriverId(p.id));
}

/**
 * The agent CLI a session runs on. An explicit `--provider` must name an
 * installed agent CLI; otherwise the router ranks the installed ones, so
 * `router.prefer` and `MERIDIAN_DISABLE_PROVIDERS` apply here exactly as they
 * do to `ask` and `generate`.
 */
export function pickAgentProvider(task: string, forced?: string): ProviderSpec {
  const agents = agentSpecs();
  if (forced) {
    const spec = PROVIDERS.find((p) => p.id === forced);
    if (!spec) {
      const guess = didYouMean(
        forced,
        agents.map((p) => p.id),
      );
      throw new CliError(`Unknown provider "${forced}".`, {
        exitCode: EXIT.USAGE,
        hint: guess
          ? `Did you mean "${guess}"?`
          : `Agent providers: ${agents.map((p) => p.id).join(', ')}.`,
      });
    }
    if (!isDriverId(spec.id)) {
      throw new CliError(`${spec.name} is an API provider; meridian agent drives agent CLIs.`, {
        exitCode: EXIT.USAGE,
        hint: `The built-in agent for API keys arrives in a later release. Use ${agents.map((p) => `-p ${p.id}`).join(', ')}.`,
      });
    }
    if (!availableProviders(agents).includes(spec.id)) {
      throw new CliError(`${spec.name} is not available: the "${spec.binary}" CLI was not found.`, {
        exitCode: EXIT.UNAVAILABLE,
        hint: `Install it with "meridian install ${INSTALL_NAME[spec.id]}", then run "${spec.binary}" once to sign in.`,
      });
    }
    return spec;
  }
  const decision = route(task, availableProviders(agents));
  if (!decision) {
    throw new CliError('No agent CLI is installed.', {
      exitCode: EXIT.UNAVAILABLE,
      hint: 'meridian agent drives Claude Code, Codex or Gemini CLI. Install one with "meridian install claude" (or codex, gemini).',
    });
  }
  return decision.provider;
}

/**
 * The model a session asks for. Unlike `ask`, an agent session does not fall
 * back to the router's default tier: the user has already configured their
 * agent CLI, and Meridian should not quietly switch its model.
 */
export function agentModelFor(spec: ProviderSpec, override?: string): string {
  return override ?? loadConfig().router.models?.[spec.id] ?? CLI_DEFAULT_MODEL;
}

/** Installed version of an agent CLI, or null when it cannot be read. */
export function agentCliVersion(spec: ProviderSpec): string | null {
  return spec.binary ? parseVersion(versionOf(spec.binary)) : null;
}

export type StreamRunner = (
  cmd: string,
  args: string[],
  opts: StreamOptions,
) => Promise<StreamResult>;

let streamRunner: StreamRunner | null = null;

/** Test seam for the agent CLI subprocess, following `setRunForTests`. Pass null to restore. */
export function setDriverRunnerForTests(runner: StreamRunner | null): void {
  streamRunner = runner;
}

/** A turn may think for a long time; a CLI that prints nothing for this long has hung. */
const TURN_IDLE_MS = 15 * 60_000;

/** Output kept in memory per turn; events are parsed as lines arrive, so this is only for errors. */
const TURN_KEEP_CHARS = 64_000;

export interface TurnOutcome extends TurnSummary {
  aborted: boolean;
}

/** Run one turn of an agent CLI, emitting harness events as its output arrives. */
export async function runDriverTurn(
  spec: ProviderSpec,
  driver: Driver,
  turn: DriverTurn,
  emit: (body: HarnessEventBody) => unknown,
  signal?: AbortSignal,
  idleTimeoutMs: number = TURN_IDLE_MS,
): Promise<TurnOutcome> {
  const parser = driver.createParser(turn);
  const res = await (streamRunner ?? runStream)(spec.binary ?? spec.id, driver.args(turn), {
    cwd: turn.cwd,
    idleTimeoutMs,
    keepChars: TURN_KEEP_CHARS,
    onStdoutLine: (line) => {
      for (const body of parser.push(line)) emit(body);
    },
    ...(driver.promptOnStdin ? { input: turn.prompt } : {}),
    ...(signal ? { signal } : {}),
  });
  const summary = parser.finish(res);
  if (res.notFound) summary.error = `the "${spec.binary}" CLI was not found on PATH`;
  else if (res.error === 'ETIMEDOUT')
    summary.error = `${spec.binary} printed nothing for ${idleTimeoutMs / 60_000} minutes and was stopped`;
  return { ...summary, aborted: res.aborted === true };
}
