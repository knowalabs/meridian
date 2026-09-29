import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
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

/** What actually gets spawned for a command: a file plus arguments to put before the caller's. */
export interface Launcher {
  file: string;
  prefixArgs: string[];
}

const WINDOWS_LAUNCHABLE = ['.exe', '.com', '.cmd', '.bat'];

/**
 * First `where` match Windows can launch. `where npm` lists the extensionless
 * POSIX shell script npm installs alongside `npm.cmd`, and that script is not
 * a Win32 program.
 */
export function pickWhereMatch(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate && WINDOWS_LAUNCHABLE.includes(path.win32.extname(candidate).toLowerCase())) {
      return candidate;
    }
  }
  return null;
}

/**
 * The program an npm-generated .cmd shim launches, read from its text. Both
 * cmd-shim's per-package shims and npm's own npm.cmd name their target as a
 * quoted path relative to the shim's directory (`%dp0%` / `%~dp0`); the last
 * such script or .exe is the target, since node.exe and npm-prefix.js appear
 * first. Returns null for anything else (sh/pwsh-backed shims, hand-written
 * batch files), which then keeps failing loudly rather than being guessed at.
 */
export function parseCmdShim(text: string, shimPath: string): Launcher | null {
  const dir = path.win32.dirname(shimPath);
  let target: string | null = null;
  for (const match of text.matchAll(/%(?:~dp0|dp0%)\\([^"\r\n]+)"/gi)) {
    const rel = match[1]!;
    const base = path.win32.basename(rel).toLowerCase();
    if (base === 'node.exe') continue;
    if (/\.(?:c|m)?js$|\.exe$/.test(base)) target = path.win32.resolve(dir, rel);
  }
  if (!target) return null;
  return target.toLowerCase().endsWith('.exe')
    ? { file: target, prefixArgs: [] }
    : { file: process.execPath, prefixArgs: [target] };
}

/*
 * On Windows, npm-style launchers are .cmd shims, and Node refuses to spawn a
 * .cmd or .bat without a shell (EINVAL since the CVE-2024-27980 fix). Rather
 * than shell:true, which would reintroduce injection risk, a shim is resolved
 * to the script it wraps and run with this Node, or to the .exe it wraps.
 */
const resolved = new Map<string, Launcher>();
function resolveCommand(cmd: string): Launcher {
  const bare = { file: cmd, prefixArgs: [] };
  if (process.platform !== 'win32') return bare;
  const cached = resolved.get(cmd);
  if (cached) return cached;
  let file = cmd;
  if (path.win32.extname(cmd) === '' && !cmd.includes('\\') && !cmd.includes('/')) {
    const res = spawnSync('where', [cmd], { encoding: 'utf8' });
    file = (res.status === 0 ? pickWhereMatch(res.stdout ?? '') : null) ?? cmd;
  }
  let launcher: Launcher = { file, prefixArgs: [] };
  if (['.cmd', '.bat'].includes(path.win32.extname(file).toLowerCase())) {
    try {
      const shim = parseCmdShim(fs.readFileSync(file, 'utf8'), file);
      if (shim && fs.existsSync(shim.prefixArgs[0] ?? shim.file)) launcher = shim;
    } catch {
      // Unreadable shim: spawn it as-is and let the failure surface as an ExecResult.
    }
  }
  resolved.set(cmd, launcher);
  return launcher;
}

/** Run a command without a shell. Never throws. */
export function run(
  cmd: string,
  args: string[] = [],
  input?: string,
  opts: { timeoutMs?: number } = {},
): ExecResult {
  const launcher = resolveCommand(cmd);
  const res = spawnSync(launcher.file, [...launcher.prefixArgs, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  });
  const notFound =
    res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ENOENT';
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    code: res.status,
    ...(res.error ? { error: res.error.message, notFound } : {}),
  };
}

export interface StreamOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  /** Wall-clock limit for the whole run. */
  timeoutMs?: number;
  /** Limit on silence: a child that prints nothing for this long is treated as hung. */
  idleTimeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Keep only the last N characters of each stream in the result; unbounded by default. */
  keepChars?: number;
}

export interface StreamResult extends ExecResult {
  /** True when `signal` stopped the child. */
  aborted?: boolean;
}

/** How long a child gets to exit on its own after the first signal before it is killed outright. */
const KILL_GRACE_MS = 5_000;

/*
 * Children still running when Meridian exits. The SIGINT handler in index.ts
 * calls process.exit synchronously, which skips every pending abort path, so
 * this is the last chance to stop an agent CLI mid-edit.
 */
const live = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;

function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    // child.kill() only ends the direct child on Windows; the tools it launched would outlive it.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill(signal);
  }
}

function stop(child: ChildProcessWithoutNullStreams, first: NodeJS.Signals): void {
  killTree(child, first);
  setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS).unref();
}

/** Line-splits a stream, holding back a partial last line until the rest arrives or the stream ends. */
function lineSplitter(onLine: ((line: string) => void) | undefined): {
  push(chunk: string): void;
  flush(): void;
} {
  let pending = '';
  return {
    push(chunk) {
      if (!onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (onLine && pending !== '') onLine(pending);
      pending = '';
    },
  };
}

/**
 * Spawn without a shell and stream output line by line. Never throws: spawn
 * failures, timeouts and aborts all come back as a result. Stdout and stderr
 * are returned untrimmed, since a caller parsing lines already saw them raw.
 */
export function runStream(
  cmd: string,
  args: string[] = [],
  opts: StreamOptions = {},
): Promise<StreamResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ ok: false, stdout: '', stderr: '', code: null, error: 'ABORTED', aborted: true });
      return;
    }
    const launcher = resolveCommand(cmd);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launcher.file, [...launcher.prefixArgs, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      });
    } catch (err) {
      // Argument validation (and EINVAL on Windows) throws synchronously instead of emitting 'error'.
      resolve({ ok: false, stdout: '', stderr: '', code: null, error: (err as Error).message });
      return;
    }
    live.add(child);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.on('exit', () => {
        for (const c of live) killTree(c, 'SIGTERM');
      });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const keep = (buf: string): string =>
      opts.keepChars !== undefined && buf.length > opts.keepChars
        ? buf.slice(buf.length - opts.keepChars)
        : buf;
    const out = lineSplitter(opts.onStdoutLine);
    const err = lineSplitter(opts.onStderrLine);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop(child, 'SIGTERM');
        }, opts.timeoutMs)
      : null;
    let idle: NodeJS.Timeout | null = null;
    const touch = (): void => {
      if (!opts.idleTimeoutMs) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        stop(child, 'SIGTERM');
      }, opts.idleTimeoutMs);
    };
    touch();
    const onAbort = (): void => {
      aborted = true;
      // SIGINT first: agent CLIs treat it as "stop this turn" and save their session.
      stop(child, 'SIGINT');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (result: StreamResult): void => {
      if (settled) return;
      settled = true;
      live.delete(child);
      if (timer) clearTimeout(timer);
      if (idle) clearTimeout(idle);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      touch();
      stdout = keep(stdout + d);
      out.push(d);
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      touch();
      stderr = keep(stderr + d);
      err.push(d);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      settle({
        ok: false,
        stdout: '',
        stderr: '',
        code: null,
        error: e.message,
        notFound: e.code === 'ENOENT',
      });
    });
    child.on('close', (code) => {
      out.flush();
      err.flush();
      settle({
        ok: code === 0 && !timedOut && !aborted,
        stdout,
        stderr,
        code,
        ...(aborted ? { error: 'ABORTED', aborted: true } : timedOut ? { error: 'ETIMEDOUT' } : {}),
      });
    });
    child.stdin.on('error', () => {}); // EPIPE if the child exits before reading
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/**
 * Async variant of {@link run}: spawns without blocking the event loop, so
 * spinners and timers keep going while a slow CLI (e.g. `claude -p`) works.
 */
export async function runAsync(
  cmd: string,
  args: string[] = [],
  input?: string,
  opts: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  const res = await runStream(cmd, args, {
    ...(input !== undefined ? { input } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return {
    ok: res.ok,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    code: res.code,
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.notFound !== undefined ? { notFound: res.notFound } : {}),
  };
}

/** Run a command inheriting stdio (for interactive installs). */
export function runLive(cmd: string, args: string[] = []): boolean {
  const launcher = resolveCommand(cmd);
  const res = spawnSync(launcher.file, [...launcher.prefixArgs, ...args], { stdio: 'inherit' });
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
