import path from 'node:path';
import type { ExecResult } from '../../core/exec.js';
import type { HarnessEventBody } from '../events.js';
import type { DriverPolicy } from '../policy.js';

/** The agent CLIs Meridian can drive, keyed by their existing router provider ids. */
export type DriverId = 'claude-code' | 'codex-cli' | 'gemini-cli';

export interface DriverTurn {
  cwd: string;
  prompt: string;
  /** Model to request, or the router's CLI_DEFAULT_MODEL to let the CLI decide. */
  model: string;
  policy: DriverPolicy;
  /** The CLI's own session to continue; absent on a session's first turn. */
  resume?: string;
  /** Session id to assign on a first turn, for CLIs that accept one up front. */
  newSessionId?: string;
  /** Installed CLI version, for flags only newer releases understand. */
  cliVersion: string | null;
  /** Cost the CLI already reported for this session, for CLIs that report running totals. */
  priorCostUsd: number;
  turn: number;
}

export interface TurnSummary {
  ok: boolean;
  driverSessionId: string | null;
  stopReason?: string;
  /** The CLI's running cost total after this turn, when it reports one. */
  cumulativeCostUsd?: number;
  /** Why the turn failed, in the CLI's words. */
  error?: string;
}

/**
 * Turns one CLI's JSONL into harness events. Pure and forgiving: an unknown
 * event type or a line that is not JSON is skipped, never thrown on — agent
 * CLIs add event types in patch releases, and one surprise line must not
 * end a session.
 */
export interface LineParser {
  push(line: string): HarnessEventBody[];
  finish(res: ExecResult): TurnSummary;
}

export interface Driver {
  providerId: DriverId;
  /** Oldest release whose headless flags this driver relies on; null when unknown. */
  minVersion: string | null;
  /** Release the parser was last checked against; null when only its docs were. */
  testedVersion: string | null;
  /** Whether the prompt goes on stdin (true) or is already in `args` (false). */
  promptOnStdin: boolean;
  /** Pure: the permission mapping for each mode lives here. */
  args(turn: DriverTurn): string[];
  createParser(turn: DriverTurn): LineParser;
  /** A caution to show before a run, e.g. for a mode that runs unsandboxed. */
  warning?(turn: DriverTurn): string | null;
}

/** First `major.minor.patch` in a `--version` line, or null. */
export function parseVersion(text: string | null): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')?.[0] ?? null;
}

/** True when `version` is at least `min`; an unknown version is assumed current. */
export function versionAtLeast(version: string | null, min: string): boolean {
  if (!version) return true;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/** A path as the project knows it: relative to `cwd` when inside it, POSIX separators. */
export function projectPath(cwd: string, file: string): string {
  const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return (inside ? rel : file).split(path.sep).join('/');
}

/** Tool output as text, whatever shape the CLI used for it. */
export function outputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

/** Parse one JSONL line into an object, or null for anything else. */
export function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Field accessors for untyped JSON, so parsers never trust a shape they did not check. */
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
export const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The last part of a failed CLI's stderr, for an error message. */
export function stderrTail(res: ExecResult, fallback: string): string {
  const text = (res.stderr || res.error || '').trim();
  return text ? text.slice(-500) : fallback;
}
