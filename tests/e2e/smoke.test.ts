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
    for (const cmd of ['doctor', 'install', 'auth', 'generate', 'mcp', 'ask']) {
      expect(res.stdout).toContain(cmd);
    }
  });

  it('bare invocation without a TTY prints the welcome overview', async () => {
    const res = await runCli([], sandbox);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Get started');
    expect(res.stdout).toContain('meridian doctor');
  });

  it('unknown commands fail with a suggestion', async () => {
    const res = await runCli(['docter'], sandbox);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('doctor');
  });

  it('ask without providers exits 1 with guidance on stderr', async () => {
    // The host machine may have Claude Code or Ollama installed — disable
    // CLI-backed providers so this test sees a truly bare environment.
    const res = await runCli(['ask', 'hello'], sandbox, {
      env: { MERIDIAN_DISABLE_PROVIDERS: 'claude-code,codex-cli,gemini-cli,ollama' },
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('meridian auth');
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

  it('reports environment, providers, vault and kit in one document', async () => {
    const res = await runCli(['doctor', '--json'], sandbox, { cwd: sandbox.project });
    const doc = JSON.parse(res.stdout) as {
      meridian: string;
      environment: { label: string; level: string }[];
      providers: { id: string; ready: boolean }[];
      vault: { backend: string | null };
      kit: { present: boolean };
    };
    expect(doc.meridian).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc.environment.map((c) => c.label)).toContain('Node.js');
    expect(doc.providers.map((p) => p.id)).toContain('anthropic');
    expect(doc.vault.backend).toBeTruthy();
    expect(doc.kit.present).toBe(false); // an empty sandbox project has no kit
  });

  it('prints a human report with next steps and stays exit 0', async () => {
    const res = await runCli(['doctor'], sandbox, { cwd: sandbox.project });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('AI providers');
    expect(res.stdout).toContain('Project kit');
    expect(res.stdout).toContain('Next steps');
  });
});
