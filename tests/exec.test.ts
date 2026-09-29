import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parseCmdShim, pickWhereMatch, runAsync, runStream } from '../src/core/exec.js';

/** The shim npm's cmd-shim writes for a JS bin, e.g. a global `codex` install. */
const JS_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

/** cmd-shim's output for a package whose bin is a native executable. */
const EXE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*',
].join('\r\n');

/** npm.cmd as shipped with Node 22's Windows installer. */
const NPM_CMD = [
  ":: Created by npm, please don't edit manually.",
  '@ECHO OFF',
  'SETLOCAL',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
  ')',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
].join('\r\n');

describe('runAsync', () => {
  it('resolves with a failed result when spawn throws synchronously', async () => {
    // Node validates arguments before spawning and throws instead of emitting
    // 'error' — the same path a .cmd shim takes on Windows (EINVAL).
    const res = await runAsync('bad\0command');
    expect(res.ok).toBe(false);
    expect(res.code).toBeNull();
    expect(res.error).toMatch(/null bytes/);
  });
});

describe('pickWhereMatch', () => {
  it('skips the extensionless POSIX script npm installs beside the .cmd', () => {
    const out = 'C:\\Program Files\\nodejs\\npm\r\nC:\\Program Files\\nodejs\\npm.cmd\r\n';
    expect(pickWhereMatch(out)).toBe('C:\\Program Files\\nodejs\\npm.cmd');
  });

  it('keeps the first launchable match in PATH order', () => {
    const out = 'C:\\bin\\claude.exe\r\nC:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd\r\n';
    expect(pickWhereMatch(out)).toBe('C:\\bin\\claude.exe');
  });

  it('returns null when nothing Windows can launch was found', () => {
    expect(pickWhereMatch('C:\\tools\\script\r\n')).toBeNull();
    expect(pickWhereMatch('')).toBeNull();
  });
});

describe('parseCmdShim', () => {
  const shimDir = 'C:\\Users\\x\\AppData\\Roaming\\npm';

  it('runs a JS bin with this Node rather than through cmd.exe', () => {
    const launcher = parseCmdShim(JS_SHIM, `${shimDir}\\codex.cmd`);
    expect(launcher).toEqual({
      file: process.execPath,
      prefixArgs: [path.win32.join(shimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')],
    });
  });

  it('runs a native bin directly', () => {
    expect(parseCmdShim(EXE_SHIM, `${shimDir}\\tool.cmd`)).toEqual({
      file: path.win32.join(shimDir, 'node_modules', 'tool', 'bin', 'tool.exe'),
      prefixArgs: [],
    });
  });

  it("finds npm's own CLI script, not npm-prefix.js or node.exe", () => {
    const launcher = parseCmdShim(NPM_CMD, 'C:\\Program Files\\nodejs\\npm.cmd');
    expect(launcher?.prefixArgs).toEqual([
      path.win32.join('C:\\Program Files\\nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]);
  });

  it('returns null for a batch file that does not wrap a script or executable', () => {
    expect(parseCmdShim('@ECHO off\r\n"%_prog%" "%dp0%\\run.sh" %*', 'C:\\x\\run.cmd')).toBeNull();
    expect(parseCmdShim('@echo hello', 'C:\\x\\hello.bat')).toBeNull();
  });
});

/** Run an inline Node script as the child process, portable across OSes. */
const node = (script: string): [string, string[]] => [process.execPath, ['-e', script]];

describe('runAsync behavior (pinned before the runStream refactor)', () => {
  it('captures trimmed stdout and stderr with the exit code', async () => {
    const res = await runAsync(
      ...node('process.stdout.write("  out\\n"); process.stderr.write("err\\n")'),
    );
    expect(res).toEqual({ ok: true, stdout: 'out', stderr: 'err', code: 0 });
  });

  it('reports a non-zero exit as not ok', async () => {
    const res = await runAsync(...node('process.exit(3)'));
    expect(res.ok).toBe(false);
    expect(res.code).toBe(3);
    expect(res.error).toBeUndefined();
  });

  it('writes input to stdin', async () => {
    const [cmd, args] = node('process.stdin.pipe(process.stdout)');
    const res = await runAsync(cmd, args, 'piped text');
    expect(res.stdout).toBe('piped text');
  });

  it('kills a child that outlives the timeout', async () => {
    const [cmd, args] = node('setTimeout(() => {}, 10_000)');
    const res = await runAsync(cmd, args, undefined, { timeoutMs: 100 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ETIMEDOUT');
  });

  it('flags a missing binary as notFound', async () => {
    const res = await runAsync('meridian-no-such-binary-xyz');
    expect(res.ok).toBe(false);
    expect(res.notFound).toBe(true);
  });
});

describe('runStream', () => {
  function collect(): { lines: string[]; onStdoutLine: (l: string) => void } {
    const lines: string[] = [];
    return { lines, onStdoutLine: (l) => lines.push(l) };
  }

  it('reassembles lines split across chunks and handles CRLF', async () => {
    const { lines, onStdoutLine } = collect();
    const [cmd, args] = node(
      'process.stdout.write("al"); setTimeout(() => process.stdout.write("pha\\r\\nbeta\\ngam"), 30); setTimeout(() => process.stdout.write("ma\\n"), 60)',
    );
    const res = await runStream(cmd, args, { onStdoutLine });
    expect(lines).toEqual(['alpha', 'beta', 'gamma']);
    expect(res.ok).toBe(true);
  });

  it('flushes a final line that has no newline', async () => {
    const { lines, onStdoutLine } = collect();
    await runStream(...node('process.stdout.write("one\\ntwo")'), { onStdoutLine });
    expect(lines).toEqual(['one', 'two']);
  });

  it('streams stderr lines separately and returns output untrimmed', async () => {
    const errLines: string[] = [];
    const res = await runStream(
      ...node('process.stderr.write("warn\\n"); process.stdout.write(" x \\n")'),
      {
        onStderrLine: (l) => errLines.push(l),
      },
    );
    expect(errLines).toEqual(['warn']);
    expect(res.stdout).toBe(' x \n');
  });

  it('runs in the given cwd with the given env', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-exec-')));
    try {
      const res = await runStream(
        ...node('process.stdout.write(process.cwd() + "|" + process.env.MERIDIAN_EXEC_TEST)'),
        { cwd: dir, env: { ...process.env, MERIDIAN_EXEC_TEST: 'yes' } },
      );
      expect(res.stdout).toBe(`${dir}|yes`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops the child when the signal aborts and reports it as aborted', async () => {
    const controller = new AbortController();
    const [cmd, args] = node('process.stdout.write("started\\n"); setTimeout(() => {}, 10_000)');
    const res = await runStream(cmd, args, {
      signal: controller.signal,
      onStdoutLine: () => controller.abort(),
    });
    expect(res).toMatchObject({ ok: false, aborted: true, error: 'ABORTED' });
  });

  it('does not spawn at all when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await runStream(...node('process.exit(0)'), { signal: controller.signal });
    expect(res).toMatchObject({ ok: false, aborted: true, code: null });
  });

  it('treats a child that goes silent past the idle timeout as hung', async () => {
    const res = await runStream(
      ...node('process.stdout.write("hi\\n"); setTimeout(() => {}, 10_000)'),
      {
        idleTimeoutMs: 150,
      },
    );
    expect(res).toMatchObject({ ok: false, error: 'ETIMEDOUT' });
  });

  it('keeps only the tail of each stream when keepChars is set', async () => {
    const lines: string[] = [];
    const res = await runStream(...node('for (let i = 0; i < 100; i++) console.log("line" + i)'), {
      keepChars: 20,
      onStdoutLine: (l) => lines.push(l),
    });
    expect(res.stdout.length).toBe(20);
    expect(res.stdout.endsWith('line99\n')).toBe(true);
    expect(lines).toHaveLength(100);
  });
});
