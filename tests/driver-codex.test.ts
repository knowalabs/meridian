import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessEventBody } from '../src/harness/events.js';
import { codexCliDriver } from '../src/harness/drivers/codex-cli.js';
import type { DriverTurn, TurnSummary } from '../src/harness/drivers/types.js';
import { CLI_DEFAULT_MODEL } from '../src/providers/router.js';

/*
 * codex-model-unavailable.jsonl is a real codex 0.142.4 run. The success
 * fixture is synthetic: written from codex's documented `exec --json` event
 * schema, because the recording account had no usable model at the time.
 */
const fixture = (name: string): string[] =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'drivers', name), 'utf8').split('\n');

function turn(overrides: Partial<DriverTurn> = {}): DriverTurn {
  return {
    cwd: '/work/proj',
    prompt: 'do it',
    model: CLI_DEFAULT_MODEL,
    policy: { mode: 'edit', allowCommands: [], source: 'none' },
    cliVersion: '0.142.4',
    priorCostUsd: 0,
    turn: 1,
    ...overrides,
  };
}

function replay(lines: string[], ok = true): { events: HarnessEventBody[]; summary: TurnSummary } {
  const parser = codexCliDriver.createParser(turn());
  const events = lines.flatMap((line) => parser.push(line));
  return { events, summary: parser.finish({ ok, stdout: '', stderr: '', code: ok ? 0 : 1 }) };
}

describe('codex-cli parser', () => {
  it('reads commands, file changes, messages and usage', () => {
    const { events, summary } = replay(fixture('codex-edit-and-run.synthetic.jsonl'));
    expect(events.filter((e) => e.type === 'file.changed')).toEqual([
      { type: 'file.changed', path: 'hello.txt', change: 'add', source: 'driver' },
      { type: 'file.changed', path: 'src/app.ts', change: 'update', source: 'driver' },
    ]);
    const shells = events.filter((e) => e.type === 'tool.started' && e.kind === 'shell');
    // The login-shell wrapper is stripped from what the user sees.
    expect(shells.map((e) => (e.type === 'tool.started' ? e.title : ''))).toEqual([
      'cat hello.txt',
      'curl -s https://example.com',
    ]);
    const completed = events.filter((e) => e.type === 'tool.completed');
    expect(completed.map((e) => (e.type === 'tool.completed' ? e.ok : null))).toEqual([
      true,
      true,
      false,
    ]);
    expect(events).toContainEqual({
      type: 'text',
      text: 'Created hello.txt and printed it; the network is blocked in this sandbox.',
      streamed: false,
    });
    expect(events.at(-1)).toEqual({
      type: 'usage',
      turn: 1,
      inputTokens: 24763,
      outputTokens: 122,
      cachedInputTokens: 24448,
    });
    expect(summary).toEqual({
      ok: true,
      driverSessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      stopReason: 'completed',
    });
  });

  it('fails with the final error, not the retry chatter before it', () => {
    const { events, summary } = replay(fixture('codex-model-unavailable.jsonl'), false);
    expect(events).toEqual([]);
    expect(summary.ok).toBe(false);
    expect(summary.driverSessionId).toBe('01a0ee8a-10e8-72e0-9683-1ab0707d513f');
    expect(summary.error).toMatch(/^unexpected status 404 Not Found: The model `gpt-5.5`/);
    expect(summary.error).not.toContain('Reconnecting');
  });

  it('never throws on noise', () => {
    const parser = codexCliDriver.createParser(turn());
    expect(parser.push('2026-09-30T00:00:00 WARN something')).toEqual([]);
    expect(parser.push('{"type":"item.completed","item":{"type":"brand_new"}}')).toEqual([]);
  });
});

describe('codex-cli args', () => {
  const policy = (mode: 'plan' | 'edit' | 'auto'): DriverTurn['policy'] => ({
    mode,
    allowCommands: [],
    source: 'none',
  });

  it('maps modes to sandboxes, never bypassing them', () => {
    const plan = codexCliDriver.args(turn({ policy: policy('plan') }));
    const edit = codexCliDriver.args(turn({ policy: policy('edit') }));
    const auto = codexCliDriver.args(turn({ policy: policy('auto') }));
    expect(plan).toEqual(expect.arrayContaining(['-s', 'read-only', '--skip-git-repo-check']));
    expect(edit).toEqual(expect.arrayContaining(['-s', 'workspace-write']));
    expect(edit).not.toContain('--skip-git-repo-check');
    expect(edit.join(' ')).not.toContain('network_access');
    expect(auto).toEqual(
      expect.arrayContaining(['-c', 'sandbox_workspace_write.network_access=true']),
    );
    for (const a of [plan, edit, auto]) {
      expect(a.slice(0, 2)).toEqual(['exec', '--json']);
      expect(a.at(-1)).toBe('-');
      expect(a.join(' ')).not.toMatch(/dangerously|danger-full-access/);
    }
  });

  it('passes a model only when one was chosen', () => {
    expect(codexCliDriver.args(turn())).not.toContain('-m');
    expect(codexCliDriver.args(turn({ model: 'gpt-5.4' }))).toEqual(
      expect.arrayContaining(['-m', 'gpt-5.4']),
    );
  });

  it('resumes through config, since exec resume takes no -s', () => {
    const a = codexCliDriver.args(turn({ resume: 'thread-1', policy: policy('edit') }));
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(a).toEqual(expect.arrayContaining(['-c', 'sandbox_mode="workspace-write"']));
    expect(a).not.toContain('-s');
    expect(a).not.toContain('--color');
    expect(a.slice(-2)).toEqual(['thread-1', '-']);
  });
});
