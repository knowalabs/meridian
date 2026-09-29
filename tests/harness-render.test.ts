import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogger } from '../src/core/logger.js';
import { createEmitter, type HarnessEventBody } from '../src/harness/events.js';
import { createRenderer } from '../src/harness/render.js';

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    stdout += `${String(line)}\n`;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  configureLogger({ level: 'normal', json: false });
});

function render(json: boolean, bodies: HarnessEventBody[]): void {
  const emitter = createEmitter('s1', [createRenderer({ json })]);
  for (const body of bodies) emitter.emit(body);
}

const COMPLETED: HarnessEventBody = {
  type: 'session.completed',
  status: 'succeeded',
  turns: 2,
  repairs: 1,
  filesChanged: ['a.ts'],
  verify: 'passed',
  durationMs: 1200,
};

describe('createRenderer', () => {
  it("streams the agent's words to stdout and status lines to stderr", () => {
    render(false, [
      { type: 'text.delta', text: 'Fixing ' },
      { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', title: 'npm test' },
      { type: 'text.delta', text: 'done.' },
      { type: 'text', text: 'Fixing done.', streamed: true },
      COMPLETED,
    ]);
    // The tool line forces the half-printed sentence onto its own line first.
    expect(stdout).toBe('Fixing \ndone.\n');
    expect(stderr).toContain('› npm test');
    expect(stderr).toContain('Done · 1 file changed · verified');
    expect(stderr).toContain('session s1');
  });

  it('prints unstreamed messages whole', () => {
    render(false, [{ type: 'text', text: 'All good.', streamed: false }]);
    expect(stdout).toBe('All good.\n');
  });

  it('shows failing verify steps with the tail of their output', () => {
    render(false, [
      { type: 'verify.started', attempt: 1, commands: ['npm run lint', 'npm run test'] },
      { type: 'verify.step', command: 'npm run lint', ok: true, code: 0, durationMs: 800 },
      { type: 'verify.step', command: 'npm run test', ok: false, code: 1, durationMs: 2500 },
      {
        type: 'verify.result',
        attempt: 1,
        passed: false,
        failed: { command: 'npm run test', code: 1, tail: 'expected 2\nreceived 3\n' },
      },
      { type: 'repair.attempt', attempt: 1, maxRepairs: 2, command: 'npm run test' },
    ]);
    expect(stderr).toContain('npm run lint → npm run test');
    expect(stderr).toContain('npm run test 2.5s exit 1');
    expect(stderr).toContain('    received 3');
    expect(stderr).toContain('Repair 1/2');
  });

  it('adds up per-turn cost into the summary', () => {
    render(false, [
      { type: 'usage', turn: 1, costUsd: 0.015 },
      { type: 'usage', turn: 2, costUsd: 0.02 },
      COMPLETED,
    ]);
    expect(stderr).toContain('$0.04');
  });

  it('points at --resume when verification is still failing', () => {
    render(false, [{ ...COMPLETED, status: 'verify_failed', verify: 'failed' }]);
    expect(stderr).toContain('Verification still failing after 1 repair');
    expect(stderr).toContain('meridian agent --resume');
  });

  it('writes one NDJSON line per event under --json, deltas included', () => {
    render(true, [{ type: 'text.delta', text: 'hi' }, COMPLETED]);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'text.delta', seq: 0, sessionId: 's1' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'session.completed', seq: 1 });
    expect(stderr).toBe('');
  });

  it('stays silent under --quiet', () => {
    configureLogger({ level: 'quiet' });
    render(false, [{ type: 'text.delta', text: 'hi' }, COMPLETED]);
    expect(stdout + stderr).toBe('');
  });
});
