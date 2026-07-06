import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, runCli, type Sandbox } from './helpers.js';

describe('e2e: smoke', () => {
  let sandbox: Sandbox;
  beforeEach(() => (sandbox = makeSandbox()));
  afterEach(() => sandbox.cleanup());

  it('--version prints a semver', async () => {
    const res = await runCli(['--version'], sandbox);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help lists the commands', async () => {
    const res = await runCli(['--help'], sandbox);
    expect(res.code).toBe(0);
    for (const cmd of ['doctor', 'install', 'auth', 'init', 'scan', 'mcp', 'ask']) {
      expect(res.stdout).toContain(cmd);
    }
  });

  it('bare invocation without a TTY prints the welcome overview', async () => {
    const res = await runCli([], sandbox);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Get started');
    expect(res.stdout).toContain('devpilot doctor');
  });

  it('unknown commands fail with a suggestion', async () => {
    const res = await runCli(['docter'], sandbox);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('doctor');
  });

  it('ask without providers exits 1 with guidance on stderr', async () => {
    const res = await runCli(['ask', 'hello'], sandbox);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('devpilot auth');
  });
});

describe('e2e: doctor', () => {
  let sandbox: Sandbox;
  beforeEach(() => (sandbox = makeSandbox()));
  afterEach(() => sandbox.cleanup());

  it('exits 0 and --json parses with a tools array', async () => {
    const res = await runCli(['doctor', '--json'], sandbox);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.stdout) as { tools: { id: string; installed: boolean }[] };
    expect(doc.tools.length).toBeGreaterThanOrEqual(8);
    expect(doc.tools.map((t) => t.id)).toContain('claude');
  });
});
