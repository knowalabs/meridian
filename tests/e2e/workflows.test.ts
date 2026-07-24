import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, runCli, type Sandbox } from './helpers.js';

describe('e2e: keys round-trip (file vault)', () => {
  let sandbox: Sandbox;
  beforeEach(() => (sandbox = makeSandbox()));
  afterEach(() => sandbox.cleanup());

  it('auth → list → remove', async () => {
    const add = await runCli(['auth', 'openai', 'sk-e2e-test-key-123', '--no-verify'], sandbox);
    expect(add.code).toBe(0);
    expect(add.stderr).toContain('shell history'); // arg warning

    const list = await runCli(['keys', 'list', '--json'], sandbox);
    expect(list.code).toBe(0);
    const doc = JSON.parse(list.stdout) as {
      backend: string;
      keys: { provider: string; masked: string }[];
    };
    expect(doc.backend).toBe('encrypted-file');
    expect(doc.keys).toHaveLength(1);
    expect(doc.keys[0]!.provider).toBe('openai');
    expect(doc.keys[0]!.masked).not.toContain('e2e-test');

    // The secret never lands on disk in plaintext.
    const keysDir = path.join(sandbox.home, '.devpilot', 'keys');
    for (const f of fs.readdirSync(keysDir)) {
      expect(fs.readFileSync(path.join(keysDir, f), 'utf8')).not.toContain('sk-e2e-test-key-123');
    }

    const rm = await runCli(['keys', 'remove', 'openai'], sandbox);
    expect(rm.code).toBe(0);
    const after = JSON.parse((await runCli(['keys', 'list', '--json'], sandbox)).stdout) as {
      keys: unknown[];
    };
    expect(after.keys).toHaveLength(0);
  });

  it('corrupt vault → clear error → keys repair recovers', async () => {
    await runCli(['auth', 'openai', 'sk-corrupt-me', '--no-verify'], sandbox);
    const vaultFile = path.join(sandbox.home, '.devpilot', 'keys', 'vault.enc');
    fs.writeFileSync(vaultFile, 'garbage');

    const broken = await runCli(['keys', 'list'], sandbox);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('keys repair');

    const repair = await runCli(['keys', 'repair'], sandbox);
    expect(repair.code).toBe(0);
    const list = await runCli(['keys', 'list', '--json'], sandbox);
    expect(list.code).toBe(0);
    expect((JSON.parse(list.stdout) as { keys: unknown[] }).keys).toHaveLength(0);
  });
});

describe('e2e: generate', () => {
  let sandbox: Sandbox;
  beforeEach(() => (sandbox = makeSandbox()));
  afterEach(() => sandbox.cleanup());

  it('one command reviews the codebase and writes the full AI kit, idempotent', async () => {
    fs.writeFileSync(path.join(sandbox.project, 'main.ts'), 'export const x = 1;\n');
    const gen = await runCli(['generate', '--no-ai', '--json'], sandbox);
    expect(gen.code).toBe(0);
    const doc = JSON.parse(gen.stdout) as { files: { file: string; action: string }[] };
    expect(doc.files.length).toBeGreaterThan(10);
    for (const f of [
      '.devpilot/project.json',
      '.devpilot/context.md',
      'docs/architecture.md',
      '.devpilot/rules.md',
      'README_AI.md',
      'CLAUDE.md',
      'AGENTS.md',
      '.claude/agents/code-reviewer.md',
      '.claude/skills/new-feature/SKILL.md',
      '.claude/commands/verify.md',
    ]) {
      expect(fs.existsSync(path.join(sandbox.project, f)), f).toBe(true);
    }

    const again = await runCli(['generate', '--no-ai'], sandbox);
    expect(again.code).toBe(0); // derived files refresh, the rest is kept — no crash
  });
});

describe('e2e: sync', () => {
  let sandbox: Sandbox;
  beforeEach(() => (sandbox = makeSandbox()));
  afterEach(() => sandbox.cleanup());

  it('check gates on drift, sync refreshes, edits survive', async () => {
    fs.writeFileSync(path.join(sandbox.project, 'main.ts'), 'export const x = 1;\n');
    fs.writeFileSync(
      path.join(sandbox.project, 'package.json'),
      JSON.stringify({ name: 'sync-e2e', scripts: { test: 'vitest run' } }),
    );
    expect((await runCli(['generate', '--no-ai'], sandbox)).code).toBe(0);
    expect((await runCli(['sync', '--check'], sandbox)).code).toBe(0);

    // The codebase drifts: a new script appears, a hand edit lands.
    fs.writeFileSync(
      path.join(sandbox.project, 'package.json'),
      JSON.stringify({ name: 'sync-e2e', scripts: { test: 'vitest run', lint: 'eslint .' } }),
    );
    const rules = path.join(sandbox.project, '.devpilot/rules.md');
    const edited = fs.readFileSync(rules, 'utf8') + '\n- my own rule\n';
    fs.writeFileSync(rules, edited);

    const check = await runCli(['sync', '--check'], sandbox);
    expect(check.code).toBe(1);

    expect((await runCli(['sync', '--no-ai'], sandbox)).code).toBe(0);
    expect(fs.readFileSync(rules, 'utf8')).toBe(edited); // hand edit preserved
    expect(fs.existsSync(path.join(sandbox.project, '.claude/commands/lint.md'))).toBe(true);
    expect((await runCli(['sync', '--check'], sandbox)).code).toBe(0);
  });
});

describe('e2e: mcp configure', () => {
  let sandbox: Sandbox;
  beforeEach(() => (sandbox = makeSandbox()));
  afterEach(() => sandbox.cleanup());

  it('install writes project .mcp.json with env references; remove cleans up', async () => {
    const install = await runCli(['mcp', 'install', 'github'], sandbox);
    expect(install.code).toBe(0);

    const mcpFile = path.join(sandbox.project, '.mcp.json');
    const raw = fs.readFileSync(mcpFile, 'utf8');
    const config = JSON.parse(raw) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(config.mcpServers.github).toBeDefined();
    expect(config.mcpServers.github!.env!.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
      '${GITHUB_PERSONAL_ACCESS_TOKEN}',
    );

    const list = await runCli(['mcp', 'list', '--json'], sandbox);
    expect(
      (JSON.parse(list.stdout) as { installed: { id: string }[] }).installed.map((s) => s.id),
    ).toContain('github');

    const remove = await runCli(['mcp', 'remove', 'github'], sandbox);
    expect(remove.code).toBe(0);
    const after = JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(after.mcpServers.github).toBeUndefined();
  });

  it('never destroys a malformed tool config', async () => {
    const cursorDir = path.join(sandbox.home, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, 'mcp.json'), '{broken');

    const res = await runCli(['mcp', 'install', 'memory'], sandbox);
    expect(res.stderr).toContain('Skipped');
    expect(fs.readFileSync(path.join(cursorDir, 'mcp.json'), 'utf8')).toBe('{broken');
    const backups = fs.readdirSync(cursorDir).filter((f) => f.includes('.bak-'));
    expect(backups).toHaveLength(1);
  });

  it('unknown mcp id exits 1', async () => {
    const res = await runCli(['mcp', 'install', 'not-a-server'], sandbox);
    expect(res.code).toBe(1);
  });
});

describe('e2e: quiet and stream discipline', () => {
  let sandbox: Sandbox;
  beforeEach(() => (sandbox = makeSandbox()));
  afterEach(() => sandbox.cleanup());

  it('--quiet doctor prints no stdout report', async () => {
    const res = await runCli(['doctor', '--quiet'], sandbox);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('--json output is pure JSON on stdout even with warnings on stderr', async () => {
    const res = await runCli(['keys', 'list', '--json'], sandbox);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });
});
