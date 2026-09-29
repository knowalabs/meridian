import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, EXIT } from '../src/core/errors.js';
import { loadConfig, saveConfig } from '../src/core/config.js';
import { CLI_DEFAULT_MODEL, PROVIDERS } from '../src/providers/router.js';
import type { HarnessEventBody } from '../src/harness/events.js';
import {
  DRIVERS,
  agentModelFor,
  pickAgentProvider,
  runDriverTurn,
  setDriverRunnerForTests,
} from '../src/harness/drivers/index.js';
import { parseVersion, versionAtLeast, projectPath } from '../src/harness/drivers/types.js';

const claude = PROVIDERS.find((p) => p.id === 'claude-code')!;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-drivers-'));
  process.env.MERIDIAN_HOME = home;
});
afterEach(() => {
  setDriverRunnerForTests(null);
  delete process.env.MERIDIAN_HOME;
  delete process.env.MERIDIAN_DISABLE_PROVIDERS;
  fs.rmSync(home, { recursive: true, force: true });
});

function thrown(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error('expected a CliError');
}

describe('pickAgentProvider', () => {
  it('rejects an API provider with a pointer to the agent CLIs', () => {
    const err = thrown(() => pickAgentProvider('task', 'anthropic'));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain('-p claude-code');
  });

  it('suggests the closest agent id for a typo', () => {
    const err = thrown(() => pickAgentProvider('task', 'claude-cod'));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain('claude-code');
  });

  it('says how to install a forced agent CLI that is missing', () => {
    process.env.MERIDIAN_DISABLE_PROVIDERS = 'codex-cli';
    const err = thrown(() => pickAgentProvider('task', 'codex-cli'));
    expect(err.exitCode).toBe(EXIT.UNAVAILABLE);
    expect(err.hint).toContain('meridian install codex');
  });

  it('reports when no agent CLI is installed at all', () => {
    process.env.MERIDIAN_DISABLE_PROVIDERS = 'claude-code,codex-cli,gemini-cli';
    const err = thrown(() => pickAgentProvider('task'));
    expect(err.exitCode).toBe(EXIT.UNAVAILABLE);
    expect(err.hint).toContain('meridian install claude');
  });
});

describe('agentModelFor', () => {
  it("leaves the agent CLI's own model alone unless one was chosen", () => {
    expect(agentModelFor(claude)).toBe(CLI_DEFAULT_MODEL);
    expect(agentModelFor(claude, 'opus')).toBe('opus');
    const config = loadConfig();
    config.router.models = { 'claude-code': 'haiku' };
    saveConfig(config);
    expect(agentModelFor(claude)).toBe('haiku');
  });
});

describe('runDriverTurn', () => {
  it('parses output as it streams and passes the prompt the way the driver expects', async () => {
    let seen: { cmd: string; args: string[]; input?: string; cwd?: string } | null = null;
    setDriverRunnerForTests(async (cmd, args, opts) => {
      seen = { cmd, args, input: opts.input, cwd: opts.cwd };
      opts.onStdoutLine?.('{"type":"system","subtype":"init","session_id":"s-1"}');
      opts.onStdoutLine?.(
        '{"type":"result","subtype":"success","is_error":false,"session_id":"s-1","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":2}}',
      );
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });
    const events: HarnessEventBody[] = [];
    const outcome = await runDriverTurn(
      claude,
      DRIVERS['claude-code'],
      {
        cwd: '/work/proj',
        prompt: 'fix it',
        model: CLI_DEFAULT_MODEL,
        policy: { mode: 'edit', allowCommands: [], source: 'none' },
        newSessionId: 's-1',
        cliVersion: '2.1.280',
        priorCostUsd: 0,
        turn: 1,
      },
      (e) => events.push(e),
    );
    expect(seen).toMatchObject({ cmd: 'claude', input: 'fix it', cwd: '/work/proj' });
    expect(events.map((e) => e.type)).toEqual(['usage']);
    expect(outcome).toMatchObject({ ok: true, driverSessionId: 's-1', aborted: false });
  });

  it('explains a missing binary and a hung CLI', async () => {
    const t = {
      cwd: '/p',
      prompt: 'x',
      model: CLI_DEFAULT_MODEL,
      policy: { mode: 'edit' as const, allowCommands: [], source: 'none' as const },
      cliVersion: null,
      priorCostUsd: 0,
      turn: 1,
    };
    setDriverRunnerForTests(async () => ({
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      notFound: true,
    }));
    expect((await runDriverTurn(claude, DRIVERS['claude-code'], t, () => {})).error).toContain(
      'not found on PATH',
    );
    setDriverRunnerForTests(async () => ({
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      error: 'ETIMEDOUT',
    }));
    expect((await runDriverTurn(claude, DRIVERS['claude-code'], t, () => {})).error).toContain(
      'printed nothing',
    );
  });
});

describe('driver helpers', () => {
  it('reads and compares versions', () => {
    expect(parseVersion('2.1.280 (Claude Code)')).toBe('2.1.280');
    expect(parseVersion('codex-cli 0.142.4')).toBe('0.142.4');
    expect(parseVersion(null)).toBeNull();
    expect(versionAtLeast('2.1.280', '2.1.259')).toBe(true);
    expect(versionAtLeast('2.1.200', '2.1.259')).toBe(false);
    expect(versionAtLeast('3.0.0', '2.9.9')).toBe(true);
    expect(versionAtLeast(null, '9.9.9')).toBe(true);
  });

  it('shows paths relative to the project when they are inside it', () => {
    expect(projectPath('/work/proj', '/work/proj/src/a.ts')).toBe('src/a.ts');
    expect(projectPath('/work/proj', 'src/a.ts')).toBe('src/a.ts');
    expect(projectPath('/work/proj', '/etc/hosts')).toBe('/etc/hosts');
  });
});
