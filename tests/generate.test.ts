import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_KINDS,
  isAllowedPath,
  parseFileBlocks,
} from '../src/generate/artifacts.js';
import { buildDigest } from '../src/generate/digest.js';
import { runGenerate } from '../src/generate/pipeline.js';
import { setFetchForTests } from '../src/providers/router.js';
import { openVault } from '../src/core/vault.js';
import { analyzeProject } from '../src/scan/analyzer.js';
import { generateCommand } from '../src/commands/generate.js';
import { configureLogger } from '../src/core/logger.js';

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-gen-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'demo-app',
      scripts: { test: 'vitest run', lint: 'eslint src', build: 'tsc' },
      dependencies: { express: '^4.0.0' },
      devDependencies: { vitest: '^2.0.0', eslint: '^9.0.0' },
    }),
  );
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/index.ts'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo-app\nAn express demo.\n');
  return root;
}

describe('parseFileBlocks', () => {
  it('parses multiple blocks', () => {
    const out = parseFileBlocks(
      '<<<FILE a/b.md>>>\nhello\n<<<END>>>\n<<<FILE c.md>>>\nworld\n<<<END>>>',
    );
    expect(out).toEqual([
      { file: 'a/b.md', content: 'hello\n' },
      { file: 'c.md', content: 'world\n' },
    ]);
  });

  it('unwraps a markdown fence around block content', () => {
    const out = parseFileBlocks('<<<FILE a.md>>>\n```md\n# hi\n```\n<<<END>>>');
    expect(out[0]?.content).toBe('# hi\n');
  });

  it('ignores prose outside blocks and returns empty for garbage', () => {
    expect(parseFileBlocks('Sure! Here are the files you asked for.')).toEqual([]);
    const out = parseFileBlocks('intro\n<<<FILE a.md>>>\nbody\n<<<END>>>\noutro');
    expect(out).toHaveLength(1);
  });
});

describe('isAllowedPath', () => {
  const allowed = ['.claude/agents/', '.devpilot/rules.md'];
  it('accepts files under an allowed prefix and exact matches', () => {
    expect(isAllowedPath('.claude/agents/reviewer.md', allowed)).toBe(true);
    expect(isAllowedPath('.devpilot/rules.md', allowed)).toBe(true);
  });
  it('rejects escapes, absolute paths and unrelated locations', () => {
    expect(isAllowedPath('../evil.md', allowed)).toBe(false);
    expect(isAllowedPath('.claude/agents/../../evil.md', allowed)).toBe(false);
    expect(isAllowedPath('/etc/passwd', allowed)).toBe(false);
    expect(isAllowedPath('C:\\windows\\evil', allowed)).toBe(false);
    expect(isAllowedPath('src/index.ts', allowed)).toBe(false);
    expect(isAllowedPath('.devpilot/rules.md.evil', allowed)).toBe(false);
  });
});

describe('buildDigest', () => {
  it('includes analysis facts and key file excerpts', () => {
    const root = makeProject();
    try {
      const digest = buildDigest(root);
      expect(digest.text).toContain('demo-app');
      expect(digest.text).toContain('Express');
      expect(digest.text).toContain('File: README.md');
      expect(digest.text).toContain('test="vitest run"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('static fallbacks', () => {
  it('every kind produces at least one file inside its allowed paths', () => {
    const root = makeProject();
    try {
      const analysis = analyzeProject(root);
      for (const kind of ARTIFACT_KINDS) {
        const files = kind.fallback(analysis);
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) expect(isAllowedPath(f.file, kind.allowedPaths)).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runGenerate', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = makeProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-home-'));
    process.env.DEVPILOT_HOME = home;
    process.env.DEVPILOT_VAULT = 'file';
  });
  afterEach(() => {
    setFetchForTests(null);
    delete process.env.DEVPILOT_HOME;
    delete process.env.DEVPILOT_VAULT;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('generates the full static kit when no provider is available', async () => {
    const result = await runGenerate({
      root,
      kinds: [],
      force: false,
      dryRun: false,
      noAi: true,
    });
    expect(result.provider).toBeNull();
    const written = result.files.filter((f) => f.action === 'written').map((f) => f.file);
    expect(written).toContain('.devpilot/rules.md');
    expect(written).toContain('.claude/agents/code-reviewer.md');
    expect(written).toContain('.claude/commands/test.md');
    expect(written).toContain('.claude/skills/project-conventions/SKILL.md');
    // Rules were propagated to every tool's instruction file.
    expect(result.propagated).toContain('CLAUDE.md');
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(true);
    // Slash command uses the real script.
    const testCmd = fs.readFileSync(path.join(root, '.claude/commands/test.md'), 'utf8');
    expect(testCmd).toContain('npm run test');
  });

  it('skips existing files unless --force', async () => {
    fs.mkdirSync(path.join(root, '.devpilot'), { recursive: true });
    fs.writeFileSync(path.join(root, '.devpilot/rules.md'), 'MINE');
    const result = await runGenerate({
      root,
      kinds: ['rules'],
      force: false,
      dryRun: false,
      noAi: true,
    });
    expect(result.files[0]?.action).toBe('skipped-exists');
    expect(fs.readFileSync(path.join(root, '.devpilot/rules.md'), 'utf8')).toBe('MINE');
    expect(result.propagated).toEqual([]);

    const forced = await runGenerate({
      root,
      kinds: ['rules'],
      force: true,
      dryRun: false,
      noAi: true,
    });
    expect(forced.files[0]?.action).toBe('written');
    expect(fs.readFileSync(path.join(root, '.devpilot/rules.md'), 'utf8')).not.toBe('MINE');
  });

  it('dry run plans without writing', async () => {
    const result = await runGenerate({
      root,
      kinds: ['agents'],
      force: false,
      dryRun: true,
      noAi: true,
    });
    expect(result.files.every((f) => f.action === 'planned')).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it('uses the AI provider and rejects unsafe paths it returns', async () => {
    openVault().set('anthropic', 'test-key');
    const aiText = [
      '<<<FILE .claude/agents/api-reviewer.md>>>',
      '---',
      'name: api-reviewer',
      'description: Reviews express routes.',
      '---',
      'Review routes.',
      '<<<END>>>',
      '<<<FILE ../../outside.md>>>',
      'evil',
      '<<<END>>>',
    ].join('\n');
    setFetchForTests(async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: aiText }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await runGenerate({
      root,
      kinds: ['agents'],
      provider: 'anthropic',
      force: false,
      dryRun: false,
      noAi: false,
    });
    expect(result.provider).toBe('anthropic');
    const byFile = Object.fromEntries(result.files.map((f) => [f.file, f.action]));
    expect(byFile['.claude/agents/api-reviewer.md']).toBe('written');
    expect(byFile['../../outside.md']).toBe('rejected-path');
    expect(fs.existsSync(path.join(root, '.claude/agents/api-reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(root), 'outside.md'))).toBe(false);
  });

  it('routes to the best available provider when none is forced', async () => {
    openVault().set('anthropic', 'test-key');
    setFetchForTests(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '<<<FILE .devpilot/prompts/x.md>>>\nhi\n<<<END>>>' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await runGenerate({
      root,
      kinds: ['prompts'],
      force: false,
      dryRun: false,
      noAi: false,
    });
    expect(result.provider).toBe('anthropic');
    expect(result.files[0]).toMatchObject({ file: '.devpilot/prompts/x.md', action: 'written' });
  });

  it('falls back to static content when the AI call fails', async () => {
    openVault().set('anthropic', 'test-key');
    setFetchForTests(async () => new Response('boom', { status: 500 }));
    const result = await runGenerate({
      root,
      kinds: ['agents'],
      provider: 'anthropic',
      force: false,
      dryRun: false,
      noAi: false,
    });
    expect(result.degraded).toContain('agents');
    expect(result.files.some((f) => f.file === '.claude/agents/code-reviewer.md')).toBe(true);
  });
});

describe('generateCommand', () => {
  let root: string;
  let home: string;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    root = makeProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-home-'));
    process.env.DEVPILOT_HOME = home;
    process.env.DEVPILOT_VAULT = 'file';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    configureLogger({ level: 'normal', json: false });
    vi.restoreAllMocks();
    delete process.env.DEVPILOT_HOME;
    delete process.env.DEVPILOT_VAULT;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('rejects unknown artifact kinds', async () => {
    expect(await generateCommand(['nope'], {}, root)).toBe(1);
  });

  it('fails when a forced provider is unavailable', async () => {
    expect(await generateCommand([], { provider: 'anthropic' }, root)).toBe(1);
  });

  it('emits a JSON document in --json mode', async () => {
    configureLogger({ json: true });
    expect(await generateCommand(['docs'], { ai: false }, root)).toBe(0);
    const doc = JSON.parse(String(logSpy.mock.calls.at(-1)![0])) as {
      provider: string | null;
      files: { file: string }[];
    };
    expect(doc.provider).toBeNull();
    expect(doc.files[0]?.file).toBe('.devpilot/docs/onboarding.md');
  });

  it('dry-run and rerun report without rewriting', async () => {
    expect(await generateCommand(['commands'], { ai: false, dryRun: true }, root)).toBe(0);
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
    expect(await generateCommand(['commands'], { ai: false }, root)).toBe(0);
    expect(await generateCommand(['commands'], { ai: false }, root)).toBe(0); // all skipped
    expect(await generateCommand(['commands'], { ai: false, force: true }, root)).toBe(0);
  });
});
