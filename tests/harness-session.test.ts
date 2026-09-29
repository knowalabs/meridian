import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEmitter,
  newSessionId,
  type HarnessEvent,
  type HarnessEventBody,
} from '../src/harness/events.js';
import {
  RECORD_OUTPUT_CAP,
  latestSessionId,
  projectKey,
  readSession,
  recordSink,
  resumeInfo,
  sessionFile,
} from '../src/harness/session.js';

const STARTED: HarnessEventBody = {
  type: 'session.started',
  protocol: 1,
  cwd: '/p',
  task: 'fix it',
  provider: 'claude-code',
  model: 'sonnet',
  mode: 'edit',
  verify: true,
  maxRepairs: 2,
};

describe('createEmitter', () => {
  it('stamps each event with the session id, a sequence number and a timestamp', () => {
    const seen: HarnessEvent[] = [];
    const emitter = createEmitter('s1', [(e) => seen.push(e)], () => new Date(0));
    emitter.emit({ type: 'text.delta', text: 'a' });
    emitter.emit({ type: 'text', text: 'a', streamed: true });
    expect(seen.map((e) => [e.sessionId, e.seq, e.ts])).toEqual([
      ['s1', 0, '1970-01-01T00:00:00.000Z'],
      ['s1', 1, '1970-01-01T00:00:00.000Z'],
    ]);
  });

  it('keeps sequence numbers separate per session', () => {
    const a = createEmitter('a', []);
    const b = createEmitter('b', []);
    a.emit({ type: 'text.delta', text: 'x' });
    expect(b.emit({ type: 'text.delta', text: 'y' }).seq).toBe(0);
  });
});

describe('newSessionId', () => {
  it('sorts by start time', () => {
    const early = newSessionId(new Date(2026, 8, 30, 9, 5, 1));
    const late = newSessionId(new Date(2026, 8, 30, 14, 0, 0));
    expect(early).toMatch(/^20260930-090501-[0-9a-f]{4}$/);
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe('session records', () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-proj-'));
    process.env.MERIDIAN_HOME = home;
  });
  afterEach(() => {
    delete process.env.MERIDIAN_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('keys a project by name plus a hash of its real path', () => {
    const key = projectKey(project);
    expect(key.startsWith(path.basename(project))).toBe(true);
    expect(key).toMatch(/-[0-9a-f]{12}$/);
    expect(projectKey(project)).toBe(key);
    expect(projectKey(path.join(project, '..', path.basename(project)))).toBe(key);
  });

  it('records events under Meridian home, never in the project', () => {
    const { sink, file } = recordSink(project, 's1');
    const emitter = createEmitter('s1', [sink]);
    emitter.emit(STARTED);
    expect(file.startsWith(home)).toBe(true);
    expect(fs.readdirSync(project)).toEqual([]);
    expect(readSession(file).map((e) => e.type)).toEqual(['session.started']);
  });

  it.skipIf(process.platform === 'win32')('makes records readable by their owner only', () => {
    const { sink, file } = recordSink(project, 's1');
    createEmitter('s1', [sink]).emit(STARTED);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('skips streamed deltas and caps tool output', () => {
    const { sink, file } = recordSink(project, 's1');
    const emitter = createEmitter('s1', [sink]);
    emitter.emit({ type: 'text.delta', text: 'partial' });
    emitter.emit({
      type: 'tool.completed',
      toolId: 't',
      ok: true,
      output: 'x'.repeat(RECORD_OUTPUT_CAP + 10),
    });
    const [only] = readSession(file);
    expect(only?.type).toBe('tool.completed');
    if (only?.type !== 'tool.completed') return;
    expect(only.output).toHaveLength(RECORD_OUTPUT_CAP);
    expect(only.truncated).toBe(true);
  });

  it('survives a torn last line', () => {
    const { sink, file } = recordSink(project, 's1');
    createEmitter('s1', [sink]).emit(STARTED);
    fs.appendFileSync(file, '{"type":"turn.sta');
    expect(readSession(file)).toHaveLength(1);
  });

  it('reads nothing from a missing record', () => {
    expect(readSession(path.join(home, 'nope.jsonl'))).toEqual([]);
    expect(latestSessionId(project)).toBeNull();
    expect(resumeInfo(project)).toBeNull();
  });

  it('finds the newest session and what a follow-up needs from it', () => {
    for (const id of ['20260930-090000-aaaa', '20260930-100000-bbbb']) {
      const { sink } = recordSink(project, id);
      const emitter = createEmitter(id, [sink]);
      emitter.emit(STARTED);
      emitter.emit({ type: 'turn.started', turn: 1, reason: 'task' });
      emitter.emit({ type: 'turn.completed', turn: 1, ok: true, driverSessionId: `drv-${id}` });
      emitter.emit({ type: 'turn.started', turn: 2, reason: 'repair' });
      emitter.emit({ type: 'turn.completed', turn: 2, ok: false, driverSessionId: null });
    }
    expect(latestSessionId(project)).toBe('20260930-100000-bbbb');
    expect(resumeInfo(project)).toEqual({
      sessionId: '20260930-100000-bbbb',
      file: sessionFile(project, '20260930-100000-bbbb'),
      task: 'fix it',
      provider: 'claude-code',
      model: 'sonnet',
      mode: 'edit',
      driverSessionId: 'drv-20260930-100000-bbbb',
      turns: 2,
    });
    expect(resumeInfo(project, '20260930-090000-aaaa')?.driverSessionId).toBe(
      'drv-20260930-090000-aaaa',
    );
  });
});
