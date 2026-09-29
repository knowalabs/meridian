import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessEventBody } from '../src/harness/events.js';
import { claudeCodeDriver } from '../src/harness/drivers/claude-code.js';
import type { DriverTurn, TurnSummary } from '../src/harness/drivers/types.js';
import { CLI_DEFAULT_MODEL } from '../src/providers/router.js';

/** Recorded from claude 2.1.280 (haiku) in a scratch repo, then sanitized to /work/proj. */
const fixture = (name: string): string[] =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'drivers', name), 'utf8').split('\n');

function turn(overrides: Partial<DriverTurn> = {}): DriverTurn {
  return {
    cwd: '/work/proj',
    prompt: 'do it',
    model: CLI_DEFAULT_MODEL,
    policy: { mode: 'edit', allowCommands: [], source: 'none' },
    cliVersion: '2.1.280',
    priorCostUsd: 0,
    turn: 1,
    ...overrides,
  };
}

function replay(
  lines: string[],
  t: DriverTurn = turn(),
  ok = true,
): { events: HarnessEventBody[]; summary: TurnSummary } {
  const parser = claudeCodeDriver.createParser(t);
  const events = lines.flatMap((line) => parser.push(line));
  const summary = parser.finish({ ok, stdout: '', stderr: ok ? '' : 'boom', code: ok ? 0 : 1 });
  return { events, summary };
}

describe('claude-code parser', () => {
  it('turns a recorded edit-and-run turn into harness events', () => {
    const { events, summary } = replay(fixture('claude-edit-and-run.jsonl'));
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'tool.started')).toHaveLength(2);
    expect(events.find((e) => e.type === 'tool.started' && e.kind === 'edit')).toMatchObject({
      name: 'Write',
      title: 'Write hello.txt',
    });
    expect(events.find((e) => e.type === 'tool.started' && e.kind === 'shell')).toMatchObject({
      name: 'Bash',
    });
    expect(events).toContainEqual({
      type: 'file.changed',
      path: 'hello.txt',
      change: 'unknown',
      source: 'driver',
    });
    // Deltas stream first; the whole message follows, marked as already shown.
    const deltas = events.filter((e) => e.type === 'text.delta').map((e) => e.text);
    const text = events.find((e) => e.type === 'text');
    expect(text).toMatchObject({ streamed: true });
    expect(deltas.join('')).toBe(text?.type === 'text' ? text.text : '');
    expect(types.at(-1)).toBe('usage');
    expect(summary).toMatchObject({
      ok: true,
      driverSessionId: 'f0bba37f-e843-47a2-96d5-16f55167cd08',
      stopReason: 'success',
    });
    expect(summary.cumulativeCostUsd).toBeCloseTo(0.0416, 3);
  });

  it('reports a denial once and bills only this turn after --resume', () => {
    const { events, summary } = replay(
      fixture('claude-resume-denied.jsonl'),
      turn({ resume: 'f0bba37f-e843-47a2-96d5-16f55167cd08', priorCostUsd: 0.0415676 }),
    );
    const denials = events.filter((e) => e.type === 'permission.denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      tool: 'Bash',
      input: { command: "python3 -c 'print(6*7)'" },
    });
    const failed = events.find((e) => e.type === 'tool.completed');
    expect(failed).toMatchObject({ ok: false });
    const usage = events.find((e) => e.type === 'usage');
    expect(usage?.type === 'usage' ? usage.costUsd : undefined).toBeCloseTo(0.0136, 3);
    expect(summary.ok).toBe(true);
  });

  it('ignores lines that are not JSON and event types it does not know', () => {
    const parser = claudeCodeDriver.createParser(turn());
    expect(parser.push('Warning: something on stdout')).toEqual([]);
    expect(parser.push('{"type":"brand_new_event","x":1}')).toEqual([]);
    expect(parser.push('{not json')).toEqual([]);
    expect(parser.push('[1,2]')).toEqual([]);
  });

  it("keeps a subagent's text out of the top-level transcript", () => {
    const parser = claudeCodeDriver.createParser(turn());
    const line = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: { content: [{ type: 'text', text: 'inner thoughts' }] },
    });
    expect(parser.push(line)).toEqual([]);
  });

  it('fails a turn that ends without a result, with the CLI’s stderr', () => {
    const { summary } = replay(fixture('claude-edit-and-run.jsonl').slice(0, 10), turn(), false);
    expect(summary).toMatchObject({ ok: false, error: 'boom' });
  });

  it('fails a turn whose result is an error', () => {
    const { summary } = replay([
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        session_id: 's',
        total_cost_usd: 0.5,
      }),
    ]);
    expect(summary).toMatchObject({ ok: false, stopReason: 'error_max_turns' });
    expect(summary.error).toContain('error_max_turns');
  });
});

describe('claude-code args', () => {
  const args = (t: Partial<DriverTurn>): string[] => claudeCodeDriver.args(turn(t));

  it('streams JSON and pre-assigns the session id on a first turn', () => {
    const a = args({ newSessionId: 'uuid-1' });
    expect(a.slice(0, 5)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]);
    expect(a).toContain('--session-id');
    expect(a).not.toContain('--resume');
    expect(a).not.toContain('--model');
  });

  it('resumes by id instead of assigning one', () => {
    const a = args({ resume: 'uuid-1', newSessionId: 'uuid-2', model: 'opus' });
    expect(a).toEqual(expect.arrayContaining(['--resume', 'uuid-1', '--model', 'opus']));
    expect(a).not.toContain('--session-id');
  });

  it('maps each mode without ever bypassing permissions', () => {
    const allowCommands = [
      { prefix: 'npm run test', exact: true },
      { prefix: 'npm run test', exact: false },
    ];
    const plan = args({ policy: { mode: 'plan', allowCommands: [], source: 'none' } });
    const edit = args({ policy: { mode: 'edit', allowCommands, source: 'kit' } });
    const auto = args({ policy: { mode: 'auto', allowCommands, source: 'kit' } });
    expect(plan).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
    expect(edit).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(edit.slice(edit.indexOf('--allowedTools'))).toEqual([
      '--allowedTools',
      'Bash(npm run test)',
      'Bash(npm run test:*)',
    ]);
    expect(auto).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
    expect(auto).not.toContain('--allowedTools');
    for (const a of [plan, edit, auto]) {
      expect(a.join(' ')).not.toMatch(/bypass|dangerously/);
      expect(a).toEqual(expect.arrayContaining(['--permission-prompts', 'none']));
    }
  });

  it('leaves --permission-prompts out for releases that predate it', () => {
    expect(args({ cliVersion: '2.1.200' })).not.toContain('--permission-prompts');
  });
});
