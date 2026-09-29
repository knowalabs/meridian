import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StreamOptions, StreamResult } from '../src/core/exec.js';
import { CLI_DEFAULT_MODEL, PROVIDERS } from '../src/providers/router.js';
import type { HarnessEvent, HarnessMode } from '../src/harness/events.js';
import { DRIVERS, setDriverRunnerForTests } from '../src/harness/drivers/index.js';
import { runAgentSession, taskPrompt, type AgentSessionOptions } from '../src/harness/run.js';
import { setVerifyRunnerForTests, type StepResult } from '../src/harness/verify.js';

const claude = PROVIDERS.find((p) => p.id === 'claude-code')!;
const codex = PROVIDERS.find((p) => p.id === 'codex-cli')!;

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-run-')));
});
afterEach(() => {
  setDriverRunnerForTests(null);
  setVerifyRunnerForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function gitInit(): void {
  const g = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
      cwd: root,
      stdio: 'ignore',
    });
  };
  fs.writeFileSync(path.join(root, 'value.txt'), 'old\n');
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
}

interface Call {
  args: string[];
  input: string | undefined;
}

/**
 * A stand-in claude: each turn runs `effect(turnIndex)` against the project,
 * then prints the minimal stream-json a real turn ends with.
 */
function fakeClaude(effect: (turn: number) => void, opts: { fail?: boolean } = {}): Call[] {
  const calls: Call[] = [];
  setDriverRunnerForTests(async (_cmd, args, o: StreamOptions): Promise<StreamResult> => {
    calls.push({ args, input: o.input });
    effect(calls.length);
    const idx = Math.max(args.indexOf('--resume'), args.indexOf('--session-id'));
    const sid = args[idx + 1] ?? 'none';
    const lines = [
      { type: 'system', subtype: 'init', session_id: sid },
      { type: 'assistant', message: { content: [{ type: 'text', text: `turn ${calls.length}` }] } },
      {
        type: 'result',
        subtype: opts.fail ? 'error_during_execution' : 'success',
        is_error: opts.fail === true,
        session_id: sid,
        total_cost_usd: 0.01 * calls.length,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];
    for (const line of lines) o.onStdoutLine?.(JSON.stringify(line));
    return { ok: !opts.fail, stdout: '', stderr: '', code: opts.fail ? 1 : 0 };
  });
  return calls;
}

function verifyResults(results: boolean[]): string[] {
  const ran: string[] = [];
  setVerifyRunnerForTests(async (command): Promise<StepResult> => {
    ran.push(command);
    const ok = results[ran.length - 1] ?? true;
    return { ok, code: ok ? 0 : 1, output: ok ? '' : 'expected new, got old\n' };
  });
  return ran;
}

async function session(
  over: Partial<AgentSessionOptions> = {},
): Promise<{ events: HarnessEvent[]; status: string; files: string[] }> {
  const events: HarnessEvent[] = [];
  const result = await runAgentSession({
    sessionId: 's1',
    root,
    task: 'make it new',
    spec: claude,
    driver: DRIVERS['claude-code'],
    model: CLI_DEFAULT_MODEL,
    mode: 'edit',
    verifyCommands: ['npm run test'],
    verify: true,
    maxRepairs: 2,
    cliVersion: '2.1.280',
    sinks: [(e) => events.push(e)],
    ...over,
  });
  return { events, status: result.status, files: result.filesChanged };
}

const write = (content: string) => (): void =>
  fs.writeFileSync(path.join(root, 'value.txt'), content);
const types = (events: HarnessEvent[]): string[] => events.map((e) => e.type);
const completed = (events: HarnessEvent[]) => events.at(-1);

describe('runAgentSession', () => {
  it('skips verification when the agent changed nothing', async () => {
    gitInit();
    fakeClaude(() => {});
    const ran = verifyResults([]);
    const { events, status } = await session();
    expect(status).toBe('no_changes');
    expect(ran).toEqual([]);
    expect(types(events)).not.toContain('verify.started');
  });

  it('succeeds when the change passes verification first time', async () => {
    gitInit();
    fakeClaude(write('new\n'));
    verifyResults([true]);
    const { events, status, files } = await session();
    expect(status).toBe('succeeded');
    expect(files).toEqual(['value.txt']);
    expect(completed(events)).toMatchObject({ verify: 'passed', repairs: 0, turns: 1 });
  });

  it('sends a failure back to the same agent session and verifies again', async () => {
    gitInit();
    const calls = fakeClaude((turn) => write(turn === 1 ? 'wrong\n' : 'new\n')());
    const ran = verifyResults([false, true]);
    const { events, status } = await session();
    expect(status).toBe('succeeded');
    expect(ran).toEqual(['npm run test', 'npm run test']);
    const firstId = calls[0]!.args[calls[0]!.args.indexOf('--session-id') + 1];
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['--resume', firstId]));
    expect(calls[1]!.input).toContain('expected new, got old');
    expect(calls[1]!.input).toContain('untrusted');
    expect(types(events)).toContain('repair.attempt');
    expect(completed(events)).toMatchObject({ verify: 'passed', repairs: 1, turns: 2 });
    // Claude reports a running total; each turn is billed only its own share.
    const costs = events.flatMap((e) => (e.type === 'usage' ? [e.costUsd] : []));
    expect(costs[0]).toBeCloseTo(0.01);
    expect(costs[1]).toBeCloseTo(0.01);
  });

  it.each([0, 1, 2])('gives up after %i repair(s)', async (maxRepairs) => {
    gitInit();
    let n = 0;
    fakeClaude(() => write(`attempt ${++n}\n`)());
    const ran = verifyResults([false, false, false, false]);
    const { events, status } = await session({ maxRepairs });
    expect(status).toBe('verify_failed');
    expect(ran).toHaveLength(maxRepairs + 1);
    expect(completed(events)).toMatchObject({ verify: 'failed', repairs: maxRepairs });
  });

  it('does not verify with --no-verify, or in plan mode', async () => {
    gitInit();
    fakeClaude(write('new\n'));
    const ran = verifyResults([false]);
    expect((await session({ verify: false })).status).toBe('succeeded');
    fs.writeFileSync(path.join(root, 'value.txt'), 'old\n');
    const plan = await session({ mode: 'plan' as HarnessMode, verifyCommands: [] });
    expect(plan.status).toBe('succeeded');
    expect(ran).toEqual([]);
  });

  it('cannot repair when the agent reports no session to resume', async () => {
    gitInit();
    // Codex with no thread.started line: nothing to resume.
    setDriverRunnerForTests(async (_cmd, _args, o) => {
      write('wrong\n')();
      o.onStdoutLine?.(JSON.stringify({ type: 'turn.completed', usage: {} }));
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });
    verifyResults([false]);
    const { events, status } = await session({ spec: codex, driver: DRIVERS['codex-cli'] });
    expect(status).toBe('verify_failed');
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      fatal: false,
      message: expect.stringContaining('no session to resume') as unknown,
    });
  });

  it('reports a failed agent turn as a fatal error', async () => {
    gitInit();
    fakeClaude(() => {}, { fail: true });
    const { events, status } = await session();
    expect(status).toBe('failed');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ fatal: true, source: 'driver' });
  });

  it('ends as interrupted when the run is aborted', async () => {
    gitInit();
    const controller = new AbortController();
    setDriverRunnerForTests(async () => {
      controller.abort();
      return { ok: false, stdout: '', stderr: '', code: null, aborted: true, error: 'ABORTED' };
    });
    const { status, events } = await session({ signal: controller.signal });
    expect(status).toBe('interrupted');
    expect(types(events)).not.toContain('error');
  });

  it("trusts the agent's own report outside git", async () => {
    setDriverRunnerForTests(async (_cmd, _args, o) => {
      fs.writeFileSync(path.join(root, 'new.txt'), 'x');
      const lines = [
        { type: 'system', subtype: 'init', session_id: 'sid' },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'Write',
                input: { file_path: path.join(root, 'new.txt') },
              },
            ],
          },
        },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        },
        { type: 'result', subtype: 'success', is_error: false, session_id: 'sid', usage: {} },
      ];
      for (const line of lines) o.onStdoutLine?.(JSON.stringify(line));
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });
    verifyResults([true]);
    const { status, files } = await session();
    expect(status).toBe('succeeded');
    expect(files).toEqual(['new.txt']);
  });

  it('still verifies outside git when the agent reports no edits', async () => {
    // A shell-made edit leaves no trace without git, so silence proves nothing.
    fakeClaude(() => fs.writeFileSync(path.join(root, 'via-shell.txt'), 'x'));
    const ran = verifyResults([true]);
    const { status } = await session();
    expect(status).toBe('succeeded');
    expect(ran).toEqual(['npm run test']);
  });

  it('warns when a project has nothing to verify with', async () => {
    gitInit();
    fakeClaude(write('new\n'));
    const { events, status } = await session({ verifyCommands: [] });
    expect(status).toBe('succeeded');
    expect(completed(events)).toMatchObject({ verify: 'skipped' });
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      fatal: false,
      source: 'verify',
    });
  });

  it('continues a recorded session instead of starting a new one', async () => {
    gitInit();
    const calls = fakeClaude(write('new\n'));
    verifyResults([true]);
    const { events } = await session({
      task: 'also this',
      resume: {
        sessionId: 's1',
        file: '/x',
        task: 'first',
        provider: 'claude-code',
        model: CLI_DEFAULT_MODEL,
        mode: 'edit',
        driverSessionId: 'drv-1',
        turns: 3,
        costUsd: 0,
      },
    });
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--resume', 'drv-1']));
    expect(calls[0]!.input).toBe('also this');
    expect(events[0]).toMatchObject({ type: 'session.started', resumedFrom: 's1' });
    expect(events.find((e) => e.type === 'turn.started')).toMatchObject({
      turn: 4,
      reason: 'followup',
    });
  });
});

describe('taskPrompt', () => {
  it('tells the agent how it will be judged, or that it may only look', () => {
    expect(taskPrompt('fix it', 'edit', ['npm run lint', 'npm run test'])).toContain(
      '`npm run lint`, `npm run test`',
    );
    expect(taskPrompt('fix it', 'edit', [])).toBe('fix it');
    expect(taskPrompt('why?', 'plan', ['npm run test'])).toContain('read-only');
  });
});
