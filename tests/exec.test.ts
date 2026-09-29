import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { parseCmdShim, pickWhereMatch, runAsync } from '../src/core/exec.js';

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
