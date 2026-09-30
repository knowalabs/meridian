import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/config.js';
import { CliError, EXIT } from '../core/errors.js';
import { jsonMode, log } from '../core/logger.js';
import { promptLine, readPipedInput } from '../core/prompt.js';
import { CLI_DEFAULT_MODEL } from '../providers/router.js';
import { analyzeProject } from '../scan/analyzer.js';
import {
  HARNESS_MODES,
  newSessionId,
  type HarnessMode,
  type SessionStatus,
} from '../harness/events.js';
import {
  DRIVERS,
  agentCliVersion,
  agentModelFor,
  isDriverId,
  pickAgentProvider,
} from '../harness/drivers/index.js';
import { createRenderer } from '../harness/render.js';
import { runAgentSession } from '../harness/run.js';
import { latestSessionId, recordSink, resumeInfo } from '../harness/session.js';
import { verifyPlan } from '../harness/verify.js';
import { acceptLesson, type PendingLesson } from '../harness/lessons.js';
import { RULE_TARGETS } from '../rules/generators.js';
import { LESSONS_FILE } from '../rules/lessons.js';

export interface AgentOptions {
  provider?: string;
  model?: string;
  mode?: string;
  /** False with --no-verify. */
  verify?: boolean;
  maxRepairs?: string;
  /** True for a bare --resume, the session id when one is given. */
  resume?: string | boolean;
  /** False with --no-learn. */
  learn?: boolean;
}

/** Files every AI tool reads as instructions; an agent editing one is worth a second look. */
const INSTRUCTION_FILES = [
  '.meridian/rules.md',
  LESSONS_FILE,
  // Changed files come from git, which always uses forward slashes.
  ...RULE_TARGETS.map((t) => t.file.split(path.sep).join('/')),
];

const EXIT_FOR: Record<SessionStatus, number> = {
  succeeded: EXIT.OK,
  no_changes: EXIT.OK,
  verify_failed: EXIT.ERROR,
  failed: EXIT.ERROR,
  interrupted: EXIT.SIGINT,
};

function parseMode(value: string): HarnessMode {
  if ((HARNESS_MODES as string[]).includes(value)) return value as HarnessMode;
  throw new CliError(`Unknown mode "${value}".`, {
    exitCode: EXIT.USAGE,
    hint: 'Modes: plan (read-only), edit (edits and the kit’s commands — the default), auto (everything the agent’s own sandbox allows).',
  });
}

function parseRepairs(value: string): number {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0 && n <= 5) return n;
  throw new CliError(`--max-repairs must be a whole number from 0 to 5, not "${value}".`, {
    exitCode: EXIT.USAGE,
  });
}

/**
 * `meridian agent`: hand a task to an installed agent CLI, then hold the
 * result to the project's own verification chain.
 */
export async function agentCommand(
  taskParts: string[],
  opts: AgentOptions,
  root: string = process.cwd(),
): Promise<number> {
  const defaults = loadConfig().harness ?? {};
  const maxRepairs =
    opts.maxRepairs !== undefined ? parseRepairs(opts.maxRepairs) : (defaults.maxRepairs ?? 2);
  const verify = opts.verify !== false;
  // --no-learn wins; otherwise the config decides, and learning is on by default.
  const learn = opts.learn === false ? false : (defaults.learn ?? true);

  const resume =
    opts.resume === undefined
      ? null
      : resumeInfo(root, typeof opts.resume === 'string' ? opts.resume : undefined);
  if (opts.resume !== undefined && !resume) {
    throw new CliError(
      typeof opts.resume === 'string'
        ? `No agent session "${opts.resume}" was found for this project.`
        : 'There is no earlier agent session in this project to continue.',
      { exitCode: EXIT.USAGE, hint: 'Start one with: meridian agent "<what to do>"' },
    );
  }
  if (resume && opts.provider && opts.provider !== resume.provider) {
    throw new CliError(
      `Session ${resume.sessionId} ran on ${resume.provider}; it cannot continue on ${opts.provider}.`,
      { exitCode: EXIT.USAGE, hint: 'Drop --provider, or start a new session.' },
    );
  }

  // A follow-up keeps the mode its session started in unless told otherwise.
  const mode = parseMode(opts.mode ?? resume?.mode ?? defaults.mode ?? 'edit');

  const piped = await readPipedInput();
  let task = taskParts.join(' ').trim();
  if (piped) task = `${task || 'Work on the input below.'}\n\n--- INPUT ---\n${piped}`;
  if (!task && resume) task = 'Continue.';
  if (!task) {
    throw new CliError('Tell the agent what to do.', {
      exitCode: EXIT.USAGE,
      hint: 'Example: meridian agent "make the failing test pass"',
    });
  }

  const spec = pickAgentProvider(task, resume?.provider ?? opts.provider);
  if (!isDriverId(spec.id)) throw new CliError(`${spec.name} cannot run agent sessions.`);
  const recordedModel = resume && resume.model !== CLI_DEFAULT_MODEL ? resume.model : undefined;
  const model = agentModelFor(spec, opts.model ?? recordedModel);
  const verifyCommands =
    verify && mode !== 'plan' ? verifyPlan(analyzeProject(root), defaults.verify) : [];

  if (!jsonMode() && latestSessionId(root) === null) {
    // -p skips the agent CLI's own workspace-trust prompt, so this is the only warning they get.
    log.dim(
      'First agent session in this project: the agent runs with this repository’s own hooks and MCP servers,\n' +
        'and verification runs its scripts. Only run meridian agent in repositories you trust.',
    );
  }

  const sessionId = resume?.sessionId ?? newSessionId();
  const record = recordSink(root, sessionId);
  const result = await runAgentSession({
    sessionId,
    root,
    task,
    spec,
    driver: DRIVERS[spec.id],
    model,
    mode,
    verifyCommands,
    verify,
    maxRepairs,
    cliVersion: agentCliVersion(spec),
    sinks: [createRenderer({ json: jsonMode() }), record.sink],
    learn,
    ...(resume ? { resume } : {}),
  });

  const touched = result.filesChanged.filter((f) => INSTRUCTION_FILES.includes(f));
  if (touched.length && !jsonMode()) {
    log.warn(
      `The agent edited ${touched.join(', ')}, which every AI tool reads as instructions. Review that change before committing it.`,
    );
  }
  if (result.lesson) await offerLesson(root, result.lesson);
  return EXIT_FOR[result.status];
}

/**
 * Ask whether a just-learned lesson should reach every tool. Only on a
 * terminal, and No by default: a lesson becomes part of every agent's
 * instructions, so it is never added without someone reading it first.
 * Declining keeps it pending, since "not now" is the common answer.
 */
async function offerLesson(root: string, lesson: PendingLesson): Promise<void> {
  if (jsonMode()) return;
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    log.dim(
      `  Review it with: meridian lessons  (accept with: meridian lessons accept ${lesson.id})`,
    );
    return;
  }
  // Escaped so a reviewer sees exactly the characters every agent will read.
  const shown = JSON.stringify(lesson.text).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const answer = await promptLine(
    `\n  ${shown}\n  Add this lesson for every AI tool in this project? [y/N] `,
  );
  if (!/^y(es)?$/i.test(answer)) {
    log.dim(`  Kept for later: meridian lessons accept ${lesson.id}`);
    return;
  }
  const applied = acceptLesson(root, lesson.id);
  log.ok(
    `Lesson added to ${applied.mirrors.join(', ')} ${pc.dim(`(+${applied.tokenDelta} tokens per request)`)}`,
  );
  for (const file of applied.overwritten) log.warn(`${file} had hand edits; they were replaced.`);
}
