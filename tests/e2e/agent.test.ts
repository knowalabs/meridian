import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, runCli, type Sandbox } from './helpers.js';

/**
 * A stand-in `claude` that speaks just enough stream-json: the first turn
 * writes a wrong answer, a --resume turn writes the right one. It logs every
 * call so the test can check what Meridian actually asked of it.
 */
const STUB = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.1.280 (Claude Code)');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, input }) + '\\n');
  const resume = args.indexOf('--resume');
  const sid = resume >= 0 ? args[resume + 1] : args[args.indexOf('--session-id') + 1];
  fs.writeFileSync(path.join(process.cwd(), 'value.txt'), resume >= 0 ? 'good' : 'bad');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: sid });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Updated value.txt.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

describe('e2e: agent', () => {
  let sandbox: Sandbox;
  let bin: string;
  let log: string;

  beforeEach(() => {
    sandbox = makeSandbox();
    bin = path.join(sandbox.home, 'bin');
    log = path.join(sandbox.home, 'stub.log');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude.js'), STUB);
    if (process.platform === 'win32') {
      // The shape npm's cmd-shim writes, which Meridian must run without a shell.
      fs.writeFileSync(
        path.join(bin, 'claude.cmd'),
        '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\claude.js" %*\r\n',
      );
    } else {
      fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\n${STUB}`);
      fs.chmodSync(path.join(bin, 'claude'), 0o755);
    }

    const project = sandbox.project;
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'agent-e2e', private: true, scripts: { test: 'node check.js' } }),
    );
    fs.writeFileSync(
      path.join(project, 'check.js'),
      "const v = require('node:fs').readFileSync('value.txt', 'utf8');\n" +
        "if (v !== 'good') { console.error('expected good, got ' + v); process.exit(1); }\n",
    );
    fs.writeFileSync(path.join(project, 'value.txt'), 'start');
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], {
        cwd: project,
        stdio: 'ignore',
      });
    };
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => sandbox.cleanup());

  const env = (): Record<string, string> => ({
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    MERIDIAN_DISABLE_PROVIDERS: 'codex-cli,gemini-cli',
    STUB_LOG: log,
  });

  it('repairs a failing change on the same agent session until verification passes', async () => {
    const res = await runCli(
      ['agent', 'make', 'the', 'check', 'pass', '-p', 'claude-code', '--json'],
      sandbox,
      {
        env: env(),
      },
    );
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);

    const events = res.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; [k: string]: unknown });
    const flow = events
      .filter((e) =>
        ['session.started', 'verify.result', 'repair.attempt', 'session.completed'].includes(
          e.type,
        ),
      )
      .map((e) => (e.type === 'verify.result' ? `verify:${String(e.passed)}` : e.type));
    expect(flow).toEqual([
      'session.started',
      'verify:false',
      'repair.attempt',
      'verify:true',
      'session.completed',
    ]);
    expect(events.at(-1)).toMatchObject({
      status: 'succeeded',
      verify: 'passed',
      filesChanged: ['value.txt'],
    });

    const calls = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; input: string });
    expect(calls).toHaveLength(2);
    const sid = calls[0]!.args[calls[0]!.args.indexOf('--session-id') + 1];
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['--resume', sid]));
    expect(calls[1]!.input).toContain('expected good, got bad');

    const sessions = path.join(sandbox.home, '.meridian', 'sessions');
    expect(fs.readdirSync(sessions)).toHaveLength(1);
    expect(fs.existsSync(path.join(sandbox.project, '.meridian'))).toBe(false);
  });

  it('exits 69 with install guidance when no agent CLI is available', async () => {
    const res = await runCli(['agent', 'do something'], sandbox, {
      env: { MERIDIAN_DISABLE_PROVIDERS: 'claude-code,codex-cli,gemini-cli' },
    });
    expect(res.code).toBe(69);
    expect(res.stderr).toContain('meridian install');
  });
});
