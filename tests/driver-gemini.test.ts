import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessEventBody } from '../src/harness/events.js';
import { geminiCliDriver } from '../src/harness/drivers/gemini-cli.js';
import type { DriverTurn, TurnSummary } from '../src/harness/drivers/types.js';
import { CLI_DEFAULT_MODEL } from '../src/providers/router.js';

/*
 * Synthetic: written from gemini-cli's documented stream-json schema
 * (packages/core/src/output/types.ts). Replace with a recording once a
 * gemini install is available — see the driver's testedVersion.
 */
const fixture = (name: string): string[] =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'drivers', name), 'utf8').split('\n');

function turn(overrides: Partial<DriverTurn> = {}): DriverTurn {
  return {
    cwd: '/work/proj',
    prompt: 'do it',
    model: CLI_DEFAULT_MODEL,
    policy: { mode: 'edit', allowCommands: [], source: 'none' },
    cliVersion: null,
    priorCostUsd: 0,
    turn: 1,
    ...overrides,
  };
}

function replay(lines: string[], ok = true): { events: HarnessEventBody[]; summary: TurnSummary } {
  const parser = geminiCliDriver.createParser(turn());
  const events = lines.flatMap((line) => parser.push(line));
  return { events, summary: parser.finish({ ok, stdout: '', stderr: '', code: ok ? 0 : 1 }) };
}

describe('gemini-cli parser', () => {
  it('reads streamed text, tools, file changes, denials and usage', () => {
    const { events, summary } = replay(fixture('gemini-edit-and-run.synthetic.jsonl'));
    const texts = events.filter((e) => e.type === 'text');
    expect(texts).toEqual([
      { type: 'text', text: "I'll create the file.", streamed: true },
      { type: 'text', text: 'Done.', streamed: true },
    ]);
    expect(events).toContainEqual({
      type: 'file.changed',
      path: 'hello.txt',
      change: 'unknown',
      source: 'driver',
    });
    expect(events.find((e) => e.type === 'permission.denied')).toMatchObject({
      tool: 'run_shell_command',
      input: { command: 'rm -rf build' },
    });
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      turn: 1,
      inputTokens: 1300,
      outputTokens: 234,
      cachedInputTokens: 800,
    });
    // A warning is not the error a failed turn would report.
    expect(summary).toEqual({
      ok: true,
      driverSessionId: 'c3a1f0d2-1111-4a2b-9c3d-2e4f5a6b7c8d',
      stopReason: 'success',
    });
  });

  it('fails a turn that never reports a result', () => {
    const { summary } = replay(['{"type":"error","severity":"error","message":"quota exhausted"}']);
    expect(summary).toMatchObject({ ok: false, error: 'quota exhausted' });
  });
});

describe('gemini-cli args', () => {
  const allowCommands = [
    { prefix: 'npm run test', exact: true },
    { prefix: 'npm run test', exact: false },
  ];

  it('never uses the headless plan mode, which exits into YOLO', () => {
    const plan = geminiCliDriver.args(
      turn({ policy: { mode: 'plan', allowCommands: [], source: 'none' } }),
    );
    expect(plan).toEqual(expect.arrayContaining(['--approval-mode', 'default']));
    expect(plan.join(' ')).not.toContain('--approval-mode plan');
  });

  it('allows the kit commands in edit mode, once per prefix', () => {
    const edit = geminiCliDriver.args(
      turn({ policy: { mode: 'edit', allowCommands, source: 'kit' } }),
    );
    expect(edit).toEqual(expect.arrayContaining(['--approval-mode', 'auto_edit']));
    expect(edit.filter((a) => a.startsWith('run_shell_command('))).toEqual([
      'run_shell_command(npm run test)',
    ]);
  });

  it('carries the prompt in -p and warns before an unsandboxed auto run', () => {
    const t = turn({ prompt: 'fix it', policy: { mode: 'auto', allowCommands, source: 'kit' } });
    const a = geminiCliDriver.args(t);
    expect(a).toEqual(expect.arrayContaining(['--approval-mode', 'yolo']));
    expect(a.slice(-2)).toEqual(['-p', 'fix it']);
    expect(geminiCliDriver.promptOnStdin).toBe(false);
    expect(geminiCliDriver.warning?.(t)).toMatch(/without a sandbox/);
    expect(geminiCliDriver.warning?.(turn())).toBeNull();
  });

  it('resumes by session id', () => {
    expect(geminiCliDriver.args(turn({ resume: 's-1' }))).toEqual(
      expect.arrayContaining(['--resume', 's-1']),
    );
  });
});
