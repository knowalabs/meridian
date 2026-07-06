import { spawnSync } from 'node:child_process';

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run a command without a shell. Never throws. */
export function run(cmd: string, args: string[] = [], input?: string): ExecResult {
  const res = spawnSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    code: res.status,
  };
}

/** Run a command inheriting stdio (for interactive installs). */
export function runLive(cmd: string, args: string[] = []): boolean {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
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
