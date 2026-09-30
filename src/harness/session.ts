import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { meridianHome } from '../core/paths.js';
import type { EventSink, HarnessEvent, HarnessMode } from './events.js';

/** Tool output kept per event in the record; the live stream still carries all of it. */
export const RECORD_OUTPUT_CAP = 4_096;

/**
 * Directory key for one project: readable name plus a hash of its real path,
 * so two checkouts called `app` never share history. Records live under
 * Meridian's home, not the project, so a session never leaves files in the
 * repository it worked on.
 */
export function projectKey(root: string): string {
  let real = path.resolve(root);
  try {
    real = fs.realpathSync(root);
  } catch {
    // A missing root still gets a stable key from its resolved path.
  }
  const name = path.basename(real).replace(/[^A-Za-z0-9._-]/g, '-') || 'root';
  const hash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 12);
  return `${name}-${hash}`;
}

export function sessionsDir(root: string): string {
  return path.join(meridianHome(), 'sessions', projectKey(root));
}

export function sessionFile(root: string, sessionId: string): string {
  return path.join(sessionsDir(root), `${sessionId}.jsonl`);
}

function forRecord(event: HarnessEvent): HarnessEvent {
  if (event.type === 'tool.completed' && event.output && event.output.length > RECORD_OUTPUT_CAP) {
    return { ...event, output: event.output.slice(-RECORD_OUTPUT_CAP), truncated: true };
  }
  return event;
}

/**
 * A sink that appends each event to the session's JSONL record. Writes are
 * synchronous on purpose: Ctrl-C ends the process with a synchronous
 * process.exit, and everything recorded up to that moment must survive it.
 * Records hold repository output, so they are readable by their owner only.
 */
export function recordSink(root: string, sessionId: string): { sink: EventSink; file: string } {
  const file = sessionFile(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return {
    file,
    sink(event) {
      if (event.type === 'text.delta') return;
      fs.appendFileSync(file, `${JSON.stringify(forRecord(event))}\n`, { mode: 0o600 });
    },
  };
}

/** Every intact event in a record. A torn last line (the process died mid-write) is skipped. */
export function readSession(file: string): HarnessEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events: HarnessEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as { type?: unknown }).type === 'string'
      ) {
        events.push(value as HarnessEvent);
      }
    } catch {
      // Torn or foreign line: the rest of the record is still usable.
    }
  }
  return events;
}

/** Newest session id for a project — ids sort by start time. */
export function latestSessionId(root: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir(root));
  } catch {
    return null;
  }
  const ids = names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length));
  ids.sort();
  return ids.at(-1) ?? null;
}

export interface ResumeInfo {
  sessionId: string;
  file: string;
  task: string;
  provider: string;
  model: string;
  mode: HarnessMode;
  /** The agent CLI's own session to continue; null when it never reported one. */
  driverSessionId: string | null;
  /** Turns already taken, so a follow-up continues the numbering. */
  turns: number;
  /** Cost reported so far, for CLIs whose own figure is a running total. */
  costUsd: number;
}

/** What a follow-up turn needs from a recorded session, or null if there is no usable record. */
export function resumeInfo(root: string, sessionId?: string): ResumeInfo | null {
  const id = sessionId ?? latestSessionId(root);
  if (!id) return null;
  const file = sessionFile(root, id);
  const events = readSession(file);
  const started = events.find((e) => e.type === 'session.started');
  if (!started || started.type !== 'session.started') return null;
  let driverSessionId: string | null = null;
  let turns = 0;
  let costUsd = 0;
  for (const e of events) {
    if (e.type === 'turn.started') turns = Math.max(turns, e.turn);
    if (e.type === 'turn.completed' && e.driverSessionId) driverSessionId = e.driverSessionId;
    if (e.type === 'usage' && e.costUsd !== undefined) costUsd += e.costUsd;
  }
  return {
    sessionId: id,
    file,
    task: started.task,
    provider: started.provider,
    model: started.model,
    mode: started.mode,
    driverSessionId,
    turns,
    costUsd,
  };
}
