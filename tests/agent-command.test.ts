import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentCommand } from '../src/commands/agent.js';
import { CliError, EXIT } from '../src/core/errors.js';
import { configureLogger } from '../src/core/logger.js';
import { setDriverRunnerForTests } from '../src/harness/drivers/index.js';
import { latestSessionId, readSession, sessionFile } from '../src/harness/session.js';
import { setVerifyRunnerForTests } from '../src/harness/verify.js';

let home: string;
let project: string;
let bin: string;
const savedPath = process.env.PATH;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-agent-home-'));
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-agent-proj-')));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-agent-bin-'));
  process.env.MERIDIAN_HOME = home;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  setDriverRunnerForTests(null);
  setVerifyRunnerForTests(null);
  configureLogger({ level: 'normal', json: false });
  process.env.PATH = savedPath;
  delete process.env.MERIDIAN_HOME;
  delete process.env.MERIDIAN_DISABLE_PROVIDERS;
  for (const dir of [home, project, bin]) fs.rmSync(dir, { recursive: true, force: true });
});

/** Put a `claude` on PATH for detection only; the driver seam answers for it. */
function installFakeClaude(): void {
  const file = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(
    file,
    process.platform === 'win32' ? '@echo 2.1.280\r\n' : '#!/bin/sh\necho 2.1.280\n',
  );
  fs.chmodSync(file, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  process.env.MERIDIAN_DISABLE_PROVIDERS = 'codex-cli,gemini-cli';
}

async function rejection(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error('expected a CliError');
}

describe('agentCommand', () => {
  it('rejects an unknown mode and an out-of-range repair budget', async () => {
    expect((await rejection(agentCommand(['x'], { mode: 'yolo' }, project))).exitCode).toBe(
      EXIT.USAGE,
    );
    for (const maxRepairs of ['9', '-1', '1.5', 'two']) {
      const err = await rejection(agentCommand(['x'], { maxRepairs }, project));
      expect(err.exitCode).toBe(EXIT.USAGE);
    }
  });

  it('needs a task unless it is continuing a session', async () => {
    const err = await rejection(agentCommand([], {}, project));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain('meridian agent "');
  });

  it('points at an agent CLI when given an API provider', async () => {
    const err = await rejection(agentCommand(['x'], { provider: 'anthropic' }, project));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it('says how to install an agent when none is available', async () => {
    process.env.MERIDIAN_DISABLE_PROVIDERS = 'claude-code,codex-cli,gemini-cli';
    const err = await rejection(agentCommand(['x'], {}, project));
    expect(err.exitCode).toBe(EXIT.UNAVAILABLE);
    expect(err.hint).toContain('meridian install');
  });

  it('refuses to resume when there is nothing to resume', async () => {
    expect((await rejection(agentCommand(['x'], { resume: true }, project))).message).toContain(
      'no earlier agent session',
    );
    expect(
      (await rejection(agentCommand(['x'], { resume: '20260101-000000-abcd' }, project))).message,
    ).toContain('20260101-000000-abcd');
  });

  it('runs a session end to end and records it outside the project', async () => {
    installFakeClaude();
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'node check.js' } }),
    );
    setDriverRunnerForTests(async (_cmd, args, o) => {
      fs.writeFileSync(path.join(project, 'out.txt'), 'done');
      const sid = args[args.indexOf('--session-id') + 1];
      o.onStdoutLine?.(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
      o.onStdoutLine?.(
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sid }),
      );
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });
    const verified: string[] = [];
    setVerifyRunnerForTests(async (command) => {
      verified.push(command);
      return { ok: true, code: 0, output: '' };
    });

    const code = await agentCommand(['write', 'out.txt'], {}, project);
    expect(code).toBe(EXIT.OK);
    expect(verified).toEqual(['npm run test']);
    const id = latestSessionId(project)!;
    const events = readSession(sessionFile(project, id));
    expect(events[0]).toMatchObject({ type: 'session.started', provider: 'claude-code' });
    expect(events.at(-1)).toMatchObject({ type: 'session.completed', status: 'succeeded' });
    expect(fs.existsSync(path.join(project, '.meridian'))).toBe(false);

    // A follow-up continues the same record, on the same agent session.
    let resumed: string[] = [];
    setDriverRunnerForTests(async (_cmd, args, o) => {
      resumed = args;
      const sid = args[args.indexOf('--resume') + 1];
      o.onStdoutLine?.(
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sid }),
      );
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });
    expect(await agentCommand(['and', 'more'], { resume: true }, project)).toBe(EXIT.OK);
    const firstDriverId = events.find((e) => e.type === 'turn.completed');
    expect(resumed).toEqual(
      expect.arrayContaining([
        '--resume',
        firstDriverId?.type === 'turn.completed' ? firstDriverId.driverSessionId : '',
      ]),
    );
    expect(latestSessionId(project)).toBe(id);
  });

  it('exits 1 when verification still fails', async () => {
    installFakeClaude();
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'node check.js' } }),
    );
    setDriverRunnerForTests(async (_cmd, _args, o) => {
      fs.writeFileSync(path.join(project, 'out.txt'), String(Math.random()));
      o.onStdoutLine?.(
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's' }),
      );
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });
    setVerifyRunnerForTests(async () => ({ ok: false, code: 1, output: 'nope' }));
    expect(await agentCommand(['x'], { maxRepairs: '1' }, project)).toBe(EXIT.ERROR);
  });
});

describe('agentCommand and lessons', () => {
  const LESSON = 'Write `out.txt` with a trailing newline; `check.js` compares the whole file.';

  beforeEach(async () => {
    installFakeClaude();
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'node check.js' } }),
    );
    fs.writeFileSync(path.join(project, 'check.js'), '');
    const { runGenerate } = await import('../src/generate/pipeline.js');
    await runGenerate({
      root: project,
      kinds: ['rules'],
      force: false,
      dryRun: false,
      noAi: true,
      tools: ['claude'],
    });
  });

  /** An agent that needs one repair, then answers the lesson prompt. */
  function repairThenTeach(): string[][] {
    const calls: string[][] = [];
    let edits = 0;
    setDriverRunnerForTests(async (_cmd, args, o) => {
      calls.push(args);
      const lessonTurn = o.input?.includes('LESSON: NONE') === true;
      if (!lessonTurn) fs.writeFileSync(path.join(project, 'out.txt'), `attempt ${++edits}\n`);
      const text = lessonTurn ? `LESSON: ${LESSON}` : 'done';
      o.onStdoutLine?.(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
      );
      o.onStdoutLine?.(
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's' }),
      );
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });
    let verifies = 0;
    setVerifyRunnerForTests(async () => {
      const ok = ++verifies > 1;
      return { ok, code: ok ? 0 : 1, output: ok ? '' : 'nope' };
    });
    return calls;
  }

  it('leaves a learned lesson pending when nobody is at a terminal to approve it', async () => {
    const calls = repairThenTeach();
    expect(await agentCommand(['fix'], {}, project)).toBe(EXIT.OK);
    expect(calls).toHaveLength(3);
    const { pendingLessons } = await import('../src/harness/lessons.js');
    expect(pendingLessons(project).map((p) => p.text)).toEqual([LESSON]);
    expect(fs.existsSync(path.join(project, '.meridian', 'lessons.md'))).toBe(false);
  });

  it('spends no lesson turn with --no-learn, or when the config turns learning off', async () => {
    let calls = repairThenTeach();
    await agentCommand(['fix'], { learn: false }, project);
    expect(calls).toHaveLength(2);

    const { loadConfig, saveConfig } = await import('../src/core/config.js');
    const config = loadConfig();
    config.harness = { learn: false };
    saveConfig(config);
    calls = repairThenTeach();
    await agentCommand(['fix'], {}, project);
    expect(calls).toHaveLength(2);
  });
});
