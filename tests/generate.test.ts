import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARTIFACT_KINDS, isAllowedPath, parseFileBlocks } from '../src/generate/artifacts.js';
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
  it('confines the docs suite to docs/', () => {
    expect(isAllowedPath('docs/architecture.md', ['docs/'])).toBe(true);
    expect(isAllowedPath('docs/design-system-core-components.md', ['docs/'])).toBe(true);
    expect(isAllowedPath('docs/../src/index.ts', ['docs/'])).toBe(false);
    expect(isAllowedPath('docs-evil/notes.md', ['docs/'])).toBe(false);
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
      // The code map lists src/index.ts's symbols ahead of file excerpts.
      expect(digest.text).toContain('## Code map');
      expect(digest.text).toContain('src/index.ts: const app');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('scales file excerpts with the provided budget', () => {
    const root = makeProject();
    try {
      fs.writeFileSync(path.join(root, 'README.md'), '# demo-app\n' + 'x'.repeat(9_000));
      const small = buildDigest(root);
      const large = buildDigest(root, undefined, 240_000);
      expect(small.text).toContain('… (truncated)');
      expect(large.text).not.toContain('… (truncated)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('guarantees a test file a seat among the sampled sources', () => {
    const root = makeProject();
    try {
      // Enough padded modules to fill every sampling slot by size alone.
      for (let i = 0; i < 12; i++) {
        fs.writeFileSync(
          path.join(root, `src/mod${i}.ts`),
          `export const m${i} = ${i};\n` + '// padding\n'.repeat(200),
        );
      }
      fs.mkdirSync(path.join(root, 'src/__tests__'));
      fs.writeFileSync(path.join(root, 'src/__tests__/app.test.ts'), 'it("works", () => {});\n');
      const digest = buildDigest(root);
      expect(digest.includedFiles).toContain('src/__tests__/app.test.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes future-signal files (CHANGELOG, ROADMAP, TODO) when present', () => {
    const root = makeProject();
    try {
      fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n## 1.0.0\n- shipped\n');
      fs.writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n- plugin system\n');
      fs.writeFileSync(path.join(root, 'TODO.md'), '- [ ] add auth\n');
      const digest = buildDigest(root);
      expect(digest.text).toContain('File: CHANGELOG.md');
      expect(digest.text).toContain('File: ROADMAP.md');
      expect(digest.text).toContain('File: TODO.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('samples sources from non-JS languages like C++', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-cpp-'));
    try {
      fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(demo)\n');
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src/main.cpp'), '#include <iostream>\nint main() {}\n');
      const digest = buildDigest(root);
      expect(digest.text).toContain('File: CMakeLists.txt');
      expect(digest.text).toContain('File: src/main.cpp');
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

  it('every prompt demands enterprise-grade, future-aware output', () => {
    for (const kind of ARTIFACT_KINDS) {
      const prompt = kind.prompt('digest');
      expect(prompt).toContain('enterprise-grade');
      expect(prompt).toContain('maturity gaps and trajectory');
      expect(prompt).toContain('Code map');
    }
    const rules = ARTIFACT_KINDS.find((k) => k.id === 'rules')!;
    expect(rules.prompt('digest')).toContain('Raising the bar');
  });

  it('rules fallback lists adoption steps for tooling the project lacks', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-bare-'));
    try {
      // No scripts, lint, formatter or CI → every gap is reported.
      const rules = ARTIFACT_KINDS.find((k) => k.id === 'rules')!;
      const content = rules.fallback(analyzeProject(bare))[0]!.content;
      expect(content).toContain('## Raising the bar');
      expect(content).toContain('automated test suite');
      expect(content).toContain('CI pipeline');
      expect(content).toContain('linter');
      expect(content).toContain('auto-formatter');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('rules fallback praises a solid baseline instead of inventing gaps', () => {
    const root = makeProject();
    try {
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'solid-app',
          scripts: { test: 'vitest run', lint: 'eslint src', format: 'prettier -w .' },
        }),
      );
      fs.mkdirSync(path.join(root, '.github'));
      const rules = ARTIFACT_KINDS.find((k) => k.id === 'rules')!;
      const content = rules.fallback(analyzeProject(root))[0]!.content;
      expect(content).toContain('Tooling baseline is solid');
      expect(content).not.toContain('Adopt an automated test suite');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a commit skill from AI responses and always includes one statically', () => {
    const skills = ARTIFACT_KINDS.find((k) => k.id === 'skills')!;
    expect(skills.requiredFiles).toContain('.claude/skills/commit/SKILL.md');
    expect(skills.prompt('digest')).toContain('.claude/skills/commit/SKILL.md');
    const root = makeProject();
    try {
      const files = skills.fallback(analyzeProject(root)).map((f) => f.file);
      expect(files).toContain('.claude/skills/commit/SKILL.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes the commit skill interactive: approval-gated, secret hard stop, no amend/force-push', () => {
    const skills = ARTIFACT_KINDS.find((k) => k.id === 'skills')!;
    const prompt = skills.prompt('digest');
    expect(prompt).toContain('INTERACTIVE');
    expect(prompt).toContain('hard stop');
    expect(prompt).toContain('never force-push');
    const root = makeProject();
    try {
      const commit = skills
        .fallback(analyzeProject(root))
        .find((f) => f.file === '.claude/skills/commit/SKILL.md')!;
      expect(commit.content).toContain('git diff --cached');
      expect(commit.content).toContain('hard stop');
      expect(commit.content).toContain('Wait for the user to approve');
      expect(commit.content).toContain('never amend');
      expect(commit.content).toContain('Ask before pushing; never force-push');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gates destructive workflow steps on user approval in every artifact prompt', () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(kind.prompt('digest')).toContain('explicit user approval');
    }
  });

  it('adds the screen skill only for UI projects', () => {
    const root = makeProject();
    try {
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'ui-app',
          dependencies: { react: '^18.0.0' },
          scripts: { test: 'vitest run' },
        }),
      );
      const skills = ARTIFACT_KINDS.find((k) => k.id === 'skills')!.fallback(analyzeProject(root));
      expect(skills.map((f) => f.file)).toContain('.claude/skills/new-screen/SKILL.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the ecosystem commands for a non-npm project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-go-'));
    try {
      fs.writeFileSync(path.join(root, 'go.mod'), 'module demo\n\ngo 1.22\n');
      fs.writeFileSync(path.join(root, 'main.go'), 'package main\n\nfunc main() {}\n');
      const analysis = analyzeProject(root);
      const docs = ARTIFACT_KINDS.find((k) => k.id === 'docs')!.fallback(analysis);
      const workflow = docs.find((f) => f.file === 'docs/engineer-workflow.md')!.content;
      expect(workflow).toContain('go test ./...');
      expect(workflow).not.toContain('npm run');
      const commands = ARTIFACT_KINDS.find((k) => k.id === 'commands')!.fallback(analysis);
      const testCmd = commands.find((f) => f.file === '.claude/commands/test.md')!.content;
      expect(testCmd).toContain('go test ./...');
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
    expect(written).toContain('.claude/skills/new-feature/SKILL.md');
    expect(written).toContain('.claude/skills/fix-bug/SKILL.md');
    expect(written).toContain('.claude/skills/commit/SKILL.md');
    // Express project → API skill generated, no UI layer → no screen skill.
    expect(written).toContain('.claude/skills/implement-api/SKILL.md');
    expect(written).not.toContain('.claude/skills/new-screen/SKILL.md');
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
    const rules = result.files.find((f) => f.file === '.devpilot/rules.md');
    expect(rules?.action).toBe('skipped-exists');
    expect(fs.readFileSync(path.join(root, '.devpilot/rules.md'), 'utf8')).toBe('MINE');
    expect(result.propagated).toEqual([]);

    const forced = await runGenerate({
      root,
      kinds: ['rules'],
      force: true,
      dryRun: false,
      noAi: true,
    });
    const forcedRules = forced.files.find((f) => f.file === '.devpilot/rules.md');
    expect(forcedRules?.action).toBe('written');
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
    setFetchForTests(
      async () =>
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
    // The AI reading pass saved its codebase review.
    expect(byFile['.devpilot/docs/codebase-review.md']).toBe('written');
    expect(fs.existsSync(path.join(root, '.claude/agents/api-reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(root), 'outside.md'))).toBe(false);
  });

  it('routes to the best available provider when none is forced', async () => {
    openVault().set('anthropic', 'test-key');
    setFetchForTests(
      async () =>
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
    expect(result.files).toContainEqual(
      expect.objectContaining({ file: '.devpilot/prompts/x.md', action: 'written' }),
    );
  });

  it('accepts a complete response without retrying', async () => {
    openVault().set('anthropic', 'test-key');
    let calls = 0;
    const aiText = '<<<FILE .devpilot/rules.md>>>\n## General\n- Be good.\n<<<END>>>';
    setFetchForTests(async () => {
      calls++;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: aiText }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runGenerate({
      root,
      kinds: ['rules'],
      provider: 'anthropic',
      force: false,
      dryRun: false,
      noAi: false,
    });
    expect(calls).toBe(2); // review pass + one generation call
    expect(result.files).toContainEqual(
      expect.objectContaining({ file: '.devpilot/rules.md', action: 'written' }),
    );
  });

  it('retries an incomplete response once, then keeps what was returned', async () => {
    openVault().set('anthropic', 'test-key');
    let calls = 0;
    // The prompts kind expects at least 3 files — one is incomplete.
    const aiText = '<<<FILE .devpilot/prompts/only-one.md>>>\nhi\n<<<END>>>';
    setFetchForTests(async () => {
      calls++;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: aiText }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runGenerate({
      root,
      kinds: ['prompts'],
      provider: 'anthropic',
      force: false,
      dryRun: false,
      noAi: false,
    });
    expect(calls).toBe(3); // review pass + first attempt + retry
    expect(result.failed).toEqual([]);
    expect(result.files).toContainEqual(
      expect.objectContaining({ file: '.devpilot/prompts/only-one.md', action: 'written' }),
    );
  });

  it('writes nothing for a kind whose AI call fails, so a re-run can resume it', async () => {
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
    expect(result.failed).toContain('agents');
    // No silent static fallback in AI mode — the kind stays missing.
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it('aborts the run when the provider hits a usage limit', async () => {
    openVault().set('anthropic', 'test-key');
    let calls = 0;
    setFetchForTests(async () => {
      calls++;
      return new Response('5-hour usage limit reached ∙ resets 6pm', { status: 429 });
    });
    const result = await runGenerate({
      root,
      kinds: [],
      provider: 'anthropic',
      force: false,
      dryRun: false,
      noAi: false,
    });
    expect(result.aborted).toMatch(/limit/i);
    // Review call aborts everything — no per-kind calls afterwards.
    expect(result.failed.length).toBeGreaterThanOrEqual(6);
    expect(calls).toBeLessThanOrEqual(2); // review call (+1 internal 429 retry)
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

  it('fails without any AI provider unless --no-ai is passed', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = ''; // hide any local ollama binary
    try {
      expect(await generateCommand([], {}, root)).toBe(1);
      expect(fs.existsSync(path.join(root, '.devpilot'))).toBe(false);
      expect(await generateCommand([], { ai: false }, root)).toBe(0);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('emits a JSON document in --json mode', async () => {
    configureLogger({ json: true });
    expect(await generateCommand(['docs'], { ai: false }, root)).toBe(0);
    const doc = JSON.parse(String(logSpy.mock.calls.at(-1)![0])) as {
      provider: string | null;
      files: { file: string }[];
    };
    expect(doc.provider).toBeNull();
    expect(doc.files.map((f) => f.file)).toContain('docs/architecture.md');
  });

  it('dry-run and rerun report without rewriting', async () => {
    expect(await generateCommand(['commands'], { ai: false, dryRun: true }, root)).toBe(0);
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
    expect(await generateCommand(['commands'], { ai: false }, root)).toBe(0);
    expect(await generateCommand(['commands'], { ai: false }, root)).toBe(0); // all skipped
    expect(await generateCommand(['commands'], { ai: false, force: true }, root)).toBe(0);
  });
});
