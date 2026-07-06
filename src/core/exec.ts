import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  /** Spawn-level failure message (e.g. binary not found), if any. */
  error?: string;
  /** True when the command itself could not be found. */
  notFound?: boolean;
}

/*
 * On Windows, npm-style launchers are .cmd shims that spawnSync cannot start
 * without a shell. Resolve them to their real path via `where` (an .exe, so
 * it never needs resolving itself) instead of using shell:true, which would
 * reintroduce injection risk.
 */
const resolved = new Map<string, string>();
function resolveCommand(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  if (path.extname(cmd) !== '' || cmd.includes('\\') || cmd.includes('/')) return cmd;
  const cached = resolved.get(cmd);
  if (cached) return cached;
  const res = spawnSync('where', [cmd], { encoding: 'utf8' });
  const first = res.status === 0 ? (res.stdout ?? '').split(/\r?\n/)[0]?.trim() : '';
  const target = first || cmd;
  resolved.set(cmd, target);
  return target;
}

/** Run a command without a shell. Never throws. */
export function run(cmd: string, args: string[] = [], input?: string): ExecResult {
  const res = spawnSync(resolveCommand(cmd), args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const notFound = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ENOENT';
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    code: res.status,
    ...(res.error ? { error: res.error.message, notFound } : {}),
  };
}

/** Run a command inheriting stdio (for interactive installs). */
export function runLive(cmd: string, args: string[] = []): boolean {
  const res = spawnSync(resolveCommand(cmd), args, { stdio: 'inherit' });
  return res.status === 0;
}

/** Locate a binary on PATH; returns its path or null. */
export function which(bin: string): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = run(finder, [bin]);
  return res.ok && res.stdout ? (res.stdout.split('\n')[0] ?? null) : null;
}

/** Get `--version` output of a binary, or null. */
export function versionOf(bin: string, flag = '--version'): string | null {
  if (!which(bin)) return null;
  const res = run(bin, [flag]);
  if (!res.ok) return null;
  return res.stdout.split('\n')[0] ?? null;
}
