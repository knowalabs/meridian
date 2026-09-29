import crypto from 'node:crypto';

/*
 * The one event stream every agent session produces, whichever agent runs it.
 * Drivers translate their CLI's own JSONL into these, the terminal renderer
 * and session record consume them, and `meridian serve` will forward them to
 * editors unchanged — so a field added here is a protocol change, and
 * HARNESS_PROTOCOL_VERSION moves with it.
 */
export const HARNESS_PROTOCOL_VERSION = 1;

export type HarnessMode = 'plan' | 'edit' | 'auto';
export const HARNESS_MODES: readonly HarnessMode[] = ['plan', 'edit', 'auto'];

export type ToolKind = 'shell' | 'edit' | 'read' | 'search' | 'web' | 'mcp' | 'other';
export type FileChange = 'add' | 'update' | 'delete' | 'unknown';
export type SessionStatus = 'succeeded' | 'no_changes' | 'verify_failed' | 'failed' | 'interrupted';

export type HarnessEventBody =
  | {
      type: 'session.started';
      protocol: number;
      cwd: string;
      task: string;
      provider: string;
      model: string;
      mode: HarnessMode;
      verify: boolean;
      maxRepairs: number;
      resumedFrom?: string;
    }
  | { type: 'turn.started'; turn: number; reason: 'task' | 'repair' | 'followup' }
  /** Streamed assistant text; renderers show it, the session record skips it. */
  | { type: 'text.delta'; text: string }
  /** A complete assistant message; `streamed` means its deltas were already shown. */
  | { type: 'text'; text: string; streamed: boolean }
  | {
      type: 'tool.started';
      toolId: string;
      name: string;
      kind: ToolKind;
      title: string;
      input?: unknown;
    }
  | {
      type: 'tool.completed';
      toolId: string;
      ok: boolean;
      exitCode?: number;
      output?: string;
      truncated?: boolean;
    }
  | { type: 'file.changed'; path: string; change: FileChange; source: 'driver' | 'git' }
  | { type: 'permission.denied'; tool: string; input?: unknown; reason?: string }
  | {
      type: 'turn.completed';
      turn: number;
      ok: boolean;
      driverSessionId: string | null;
      stopReason?: string;
    }
  | { type: 'verify.started'; attempt: number; commands: string[] }
  | { type: 'verify.step'; command: string; ok: boolean; code: number | null; durationMs: number }
  | {
      type: 'verify.result';
      attempt: number;
      passed: boolean;
      failed?: { command: string; code: number | null; tail: string };
    }
  | { type: 'repair.attempt'; attempt: number; maxRepairs: number; command: string }
  | {
      type: 'usage';
      turn: number;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      /** Cost of this turn alone, never a running total. */
      costUsd?: number;
    }
  | {
      type: 'session.completed';
      status: SessionStatus;
      turns: number;
      repairs: number;
      filesChanged: string[];
      verify: 'passed' | 'failed' | 'skipped';
      durationMs: number;
    }
  | {
      type: 'error';
      message: string;
      fatal: boolean;
      source: 'driver' | 'harness' | 'verify';
      hint?: string;
    };

export type HarnessEventType = HarnessEventBody['type'];
export type HarnessEvent = HarnessEventBody & { sessionId: string; seq: number; ts: string };
export type EventSink = (event: HarnessEvent) => void;

export interface Emitter {
  readonly sessionId: string;
  emit(body: HarnessEventBody): HarnessEvent;
}

/**
 * Stamp and fan out events for one session. Deliberately not a process-wide
 * bus: an editor host runs several sessions at once, and each needs its own
 * sequence numbers and sinks.
 */
export function createEmitter(
  sessionId: string,
  sinks: EventSink[],
  now: () => Date = () => new Date(),
): Emitter {
  let seq = 0;
  return {
    sessionId,
    emit(body) {
      const event: HarnessEvent = { ...body, sessionId, seq: seq++, ts: now().toISOString() };
      for (const sink of sinks) sink(event);
      return event;
    },
  };
}

/** Sortable, human-typeable session id: `20260930-141502-a1b2`. */
export function newSessionId(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}
