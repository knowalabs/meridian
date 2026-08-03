import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_KINDS,
  isAllowedPath,
  kindsById,
  parseFileBlocks,
  type ArtifactKind,
} from '../src/generate/artifacts.js';
import { buildDigest } from '../src/generate/digest.js';
import {
  concurrencyFor,
  dependencyWaves,
  estimateGenerate,
  runGenerate,
  type GenerateOptions,
} from '../src/generate/pipeline.js';
import {
  setFetchForTests,
  setRetryDelayForTests,
  type ProviderSpec,
} from '../src/providers/router.js';
import { openVault } from '../src/core/vault.js';
import { analyzeProject } from '../src/scan/analyzer.js';
import { generateCommand } from '../src/commands/generate.js';
import { configureLogger } from '../src/core/logger.js';

function makeProject(extra: Record<string, string> = {}): string {
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
  for (const [file, content] of Object.entries(extra))
    fs.writeFileSync(path.join(root, file), content);
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

  it('leads the rules with the working agreement, whatever produced them', () => {
    const root = makeProject();
    try {
      const analysis = analyzeProject(root);
      const rules = ARTIFACT_KINDS.find((k) => k.id === 'rules')!;
      const [statik] = rules.finalize!(rules.fallback(analysis), analysis);
      expect(statik!.content.startsWith('## Working agreement')).toBe(true);
      for (const clause of [
        '1. Read before you write',
        '2. Follow the architecture',
        '3. Never touch documentation silently',
        '4. Improve old code without changing what it does',
        '5. Report a bug before you fix it',
      ])
        expect(statik!.content).toContain(clause);

      // An AI response that omits the section gets it anyway, and keeps its own.
      const [ai] = rules.finalize!(
        [{ file: '.devpilot/rules.md', content: '## General\n\n- Ship fast.\n' }],
        analysis,
      );
      expect(ai!.content).toContain('## Working agreement');
      expect(ai!.content).toContain('- Ship fast.');

      // Idempotent: rerunning over finalized content does not stack sections.
      expect(rules.finalize!([ai!], analysis)[0]!.content).toBe(ai!.content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds every kind to the read-first, in-architecture, hands-off-docs contract', () => {
    for (const kind of ARTIFACT_KINDS) {
      const prompt = kind.prompt('digest');
      expect(prompt).toContain(
        'read the kit files and the code it is about to touch BEFORE editing',
      );
      expect(prompt).toContain('never edit documentation as a side effect');
    }
    // The rules kind gets the section verbatim, so it must not write its own.
    expect(ARTIFACT_KINDS.find((k) => k.id === 'rules')!.prompt('digest')).toContain(
      'Do not write that section',
    );
  });

  it('treats a weak codebase as the subject, never as the standard', () => {
    for (const kind of ARTIFACT_KINDS) {
      const prompt = kind.prompt('digest');
      expect(prompt).toContain('The codebase is the subject, not the standard');
      expect(prompt).toContain('legacy to migrate rather than as precedent to copy');
    }
    // The rules file gets a section naming what is below the bar and why.
    expect(ARTIFACT_KINDS.find((k) => k.id === 'rules')!.prompt('digest')).toContain(
      '## Legacy code',
    );
  });

  it('rules fallback tells an assistant how to work in code below the standard', () => {
    const root = makeProject();
    try {
      const rules = ARTIFACT_KINDS.find((k) => k.id === 'rules')!;
      const analysis = analyzeProject(root);
      const [file] = rules.finalize!(rules.fallback(analysis), analysis);
      expect(file!.content).toContain('## Legacy code');
      // New code meets the standard, restructuring is safe, bugs are reported.
      expect(file!.content).toContain('New code meets the standard in this file');
      expect(file!.content).toContain('behavior-preserving and test-backed');
      expect(file!.content).toContain('Report a defect you find in old code before fixing it');
      expect(file!.content).toContain('npm run test');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('always ships a code-modernizer agent that cannot change behavior or fix silently', () => {
    const root = makeProject();
    try {
      const agents = ARTIFACT_KINDS.find((k) => k.id === 'agents')!;
      // The AI is held to the same file, not just the static path.
      expect(agents.requiredFiles).toContain('.claude/agents/code-modernizer.md');
      expect(agents.prompt('digest')).toContain('.claude/agents/code-modernizer.md');

      const file = agents
        .fallback(analyzeProject(root))
        .find((f) => f.file === '.claude/agents/code-modernizer.md');
      expect(file).toBeDefined();
      // It may edit, but never runs unattended destructive tooling.
      expect(file!.content).toContain('  - Edit');
      expect(file!.content).not.toContain('  - Write');
      expect(file!.content).toContain('characterization tests');
      expect(file!.content).toContain(
        'Fixing a defect you found without reporting it and getting approval first',
      );
      expect(file!.content).toContain(
        'Changing behavior, output, a public interface or an error path',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a behavior-preserving refactor workflow in every kit', () => {
    const root = makeProject();
    try {
      const skills = ARTIFACT_KINDS.find((k) => k.id === 'skills')!;
      expect(skills.requiredFiles).toContain('.claude/skills/refactor/SKILL.md');
      expect(skills.prompt('digest')).toContain('REQUIRED 4');

      const file = skills
        .fallback(analyzeProject(root))
        .find((f) => f.file === '.claude/skills/refactor/SKILL.md');
      expect(file).toBeDefined();
      expect(file!.content).toContain('characterization tests first');
      expect(file!.content).toContain(
        'Report every defect you find on the way instead of fixing it',
      );
      expect(file!.content).toContain(
        'Fix a bug you found silently while refactoring, or leave it unreported.',
      );
      expect(file!.content).toContain('Optimize on a hunch');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires the universal skills from AI responses and always includes them statically', () => {
    const skills = ARTIFACT_KINDS.find((k) => k.id === 'skills')!;
    const required = ['commit', 'handle-errors', 'document'].map(
      (name) => `.claude/skills/${name}/SKILL.md`,
    );
    const root = makeProject();
    try {
      const files = skills.fallback(analyzeProject(root)).map((f) => f.file);
      for (const path of required) {
        expect(skills.requiredFiles).toContain(path);
        expect(skills.prompt('digest')).toContain(path);
        expect(files).toContain(path);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('encodes the error-handling and public-surface standard, not generic advice', () => {
    const skills = ARTIFACT_KINDS.find((k) => k.id === 'skills')!;
    const prompt = skills.prompt('digest');
    // The prompt must demand the project's own convention, not invent one.
    expect(prompt).toContain('the real error type');
    expect(prompt).toContain('write the adoption step rather than inventing one');
    const root = makeProject();
    try {
      const errors = skills
        .fallback(analyzeProject(root))
        .find((f) => f.file === '.claude/skills/handle-errors/SKILL.md')!.content;
      expect(errors).toContain('Validate at the boundary');
      expect(errors).toContain('additive or breaking');
      expect(errors).toMatch(/stack trace/);
      expect(errors).toContain('error convention is a defect');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes the documentation skill against the changelog the project actually has', () => {
    const withLog = makeProject({ 'CHANGELOG.md': '# Changelog\n' });
    const withoutLog = makeProject();
    const documentSkill = (root: string): string =>
      ARTIFACT_KINDS.find((k) => k.id === 'skills')!
        .fallback(analyzeProject(root))
        .find((f) => f.file === '.claude/skills/document/SKILL.md')!.content;
    try {
      expect(documentSkill(withLog)).toContain('Add a `CHANGELOG.md` entry');
      // No changelog: an adoption step, never a reference to a file that is absent.
      const absent = documentSkill(withoutLog);
      expect(absent).toContain('has no changelog yet');
      expect(absent).not.toContain('CHANGELOG.md');
    } finally {
      for (const root of [withLog, withoutLog]) fs.rmSync(root, { recursive: true, force: true });
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

  it('harness fallback allowlists the real scripts and denies secret reads', () => {
    const root = makeProject();
    try {
      const harness = ARTIFACT_KINDS.find((k) => k.id === 'harness')!;
      const [settings] = harness.fallback(analyzeProject(root));
      expect(settings!.file).toBe('.claude/settings.json');
      const parsed = JSON.parse(settings!.content) as {
        permissions: { allow: string[]; deny: string[] };
      };
      expect(parsed.permissions.allow).toContain('Bash(npm run test:*)');
      expect(parsed.permissions.allow).toContain('Bash(npm run lint)');
      expect(parsed.permissions.allow).toContain('Bash(git status)');
      expect(parsed.permissions.deny).toContain('Read(./.env)');
      // Nothing destructive sneaks into the allowlist.
      expect(parsed.permissions.allow.join(' ')).not.toMatch(/push|publish|rm |sudo/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never allowlists destructive commands in the harness prompt', () => {
    const harness = ARTIFACT_KINDS.find((k) => k.id === 'harness')!;
    const prompt = harness.prompt('digest');
    expect(prompt).toContain('.claude/settings.json');
    expect(prompt).toContain('NEVER allowlist anything destructive');
    expect(prompt).toContain('"permissions.ask"');
  });

  it('harness fallback asks before documentation is written', () => {
    const root = makeProject();
    try {
      const harness = ARTIFACT_KINDS.find((k) => k.id === 'harness')!;
      const [settings] = harness.fallback(analyzeProject(root));
      const parsed = JSON.parse(settings!.content) as {
        permissions: { allow: string[]; ask: string[] };
      };
      for (const rule of ['Edit(docs/**)', 'Write(docs/**)', 'Edit(CLAUDE.md)', 'Edit(README.md)'])
        expect(parsed.permissions.ask).toContain(rule);
      // The prompt would be pointless if a write to the same path were allowed.
      expect(parsed.permissions.allow.join(' ')).not.toMatch(/Edit\(|Write\(/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the ci kind opt-in and points it at sync --check', () => {
    const ci = ARTIFACT_KINDS.find((k) => k.id === 'ci')!;
    expect(ci.optIn).toBe(true);
    expect(kindsById([]).map((k) => k.id)).not.toContain('ci');
    expect(kindsById(['ci']).map((k) => k.id)).toEqual(['ci']);
    const root = makeProject();
    try {
      const [workflow] = ci.fallback(analyzeProject(root));
      expect(workflow!.file).toBe('.github/workflows/devpilot-sync.yml');
      expect(workflow!.content).toContain('devpilot sync --check');
      expect(workflow!.content).not.toMatch(/secrets\./);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives every subagent a model, a least-privilege tool list and the full contract', () => {
    const root = makeProject();
    try {
      const agents = ARTIFACT_KINDS.find((k) => k.id === 'agents')!.fallback(analyzeProject(root));
      expect(agents.length).toBeGreaterThanOrEqual(4);
      for (const file of agents) {
        expect(file.content).toMatch(
          /^---\nname: [a-z-]+\ndescription: .+\nmodel: (haiku|sonnet|opus)\ntools:\n/,
        );
        // The contract every generated agent follows.
        for (const heading of ['## Scope', '## Context', '## Method', '## Output', '## Forbidden'])
          expect(file.content).toContain(heading);
        // Findings are evidence-backed, never speculative.
        expect(file.content).toContain('file:line');
        // Read-only agents are read-only by omission: no Edit/Write granted.
        const readOnly = file.content.includes('## Commands')
          ? !/\n\s+- (Edit|Write)\n/.test(file.content)
          : false;
        if (readOnly) expect(file.content).toMatch(/never|Read-only|do not fix|Editing/i);
      }
      const reviewer = agents.find((f) => f.file.endsWith('code-reviewer.md'))!.content;
      expect(reviewer).toContain('## Severity');
      expect(reviewer).not.toMatch(/\n {2}- (Edit|Write)\n/);
      // The reviewer's read-only command block never runs a formatter.
      const commands = /## Commands\n\n```bash\n([\s\S]*?)```/.exec(reviewer)![1]!;
      expect(commands).not.toMatch(/format|prettier/);
      const fixer = agents.find((f) => f.file.endsWith('test-fixer.md'))!.content;
      expect(fixer).toMatch(/\n {2}- Edit\n/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires the agent contract — frontmatter, least privilege and a report template — in the prompt', () => {
    const prompt = ARTIFACT_KINDS.find((k) => k.id === 'agents')!.prompt('digest');
    expect(prompt).toContain('model: haiku | sonnet | opus');
    expect(prompt).toContain('least privilege');
    expect(prompt).toContain('NOT Edit or\nWrite');
    for (const heading of ['## Scope', '## Context', '## Method', '## Output', '## Forbidden'])
      expect(prompt).toContain(heading);
  });

  it('structures every skill as when/preconditions/steps/verification/done/never', () => {
    const root = makeProject();
    try {
      const skills = ARTIFACT_KINDS.find((k) => k.id === 'skills')!.fallback(analyzeProject(root));
      for (const file of skills) {
        for (const heading of [
          '## When to use',
          '## Before you start',
          '## Steps',
          '## Verification',
          '## Done when',
          '## Never',
        ])
          expect(file.content, file.file).toContain(heading);
        // "Done when" is a checkable list, not prose.
        expect(file.content).toContain('- [ ] ');
        // Preconditions point at the kit rather than restating it.
        expect(file.content).toContain('@.devpilot/rules.md');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('declares argument hints and tool limits on the slash commands that need them', () => {
    const root = makeProject();
    try {
      const commands = ARTIFACT_KINDS.find((k) => k.id === 'commands')!.fallback(
        analyzeProject(root),
      );
      const review = commands.find((f) => f.file.endsWith('review.md'))!.content;
      expect(review).toContain('argument-hint:');
      expect(review).toContain('allowed-tools:');
      for (const heading of ['## Context', '## Task', '## Report', '## Constraints'])
        expect(review).toContain(heading);
      // Every command says what it does with the user's input.
      for (const file of commands) {
        if (file.content.includes('$ARGUMENTS')) expect(file.content).toContain('argument-hint:');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('scopes the cleanup command to the current change and forbids behavior changes', () => {
    const root = makeProject();
    try {
      const commands = ARTIFACT_KINDS.find((k) => k.id === 'commands')!.fallback(
        analyzeProject(root),
      );
      const cleanup = commands.find((f) => f.file === '.claude/commands/cleanup.md')!.content;
      // Scope comes from the session's own diff, not the whole repo.
      expect(cleanup).toContain('git diff');
      expect(cleanup).toContain('out of scope');
      expect(cleanup).toContain('argument-hint:');
      // Behavior-preserving, and the verification chain still runs afterwards.
      expect(cleanup).toContain('behavior-preserving');
      expect(cleanup).toMatch(/npm run (lint|test|build)/);
      for (const heading of ['## Context', '## Task', '## Report', '## Constraints'])
        expect(cleanup).toContain(heading);
      // The repo-wide restructuring workflow stays in the skill it belongs to.
      expect(cleanup).toContain('use the `refactor`\nskill instead');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('delegates every skill to a same-named slash command instead of restating it', () => {
    const root = makeProject();
    try {
      const analysis = analyzeProject(root);
      const skills = ARTIFACT_KINDS.find((k) => k.id === 'skills')!.fallback(analysis);
      const commands = ARTIFACT_KINDS.find((k) => k.id === 'commands')!.fallback(analysis);
      const byPath = new Map(commands.map((f) => [f.file, f.content]));

      for (const skill of skills) {
        const name = /^\.claude\/skills\/(.+)\/SKILL\.md$/.exec(skill.file)![1]!;
        const command = byPath.get(`.claude/commands/${name}.md`);
        expect(command, `no slash command delegates to the ${name} skill`).toBeDefined();
        // A handoff, not a second copy: it points at the skill and stays short.
        expect(command).toContain(`@.claude/skills/${name}/SKILL.md`);
        expect(command!.split('\n').length).toBeLessThan(15);
        for (const heading of ['## Steps', '## Verification', '## Done when'])
          expect(command, `${name} command restates the skill`).not.toContain(heading);
      }
      // Commands that are not delegators own no workflow a skill already owns.
      const skillNames = new Set(
        skills.map((f) => /^\.claude\/skills\/(.+)\/SKILL\.md$/.exec(f.file)![1]!),
      );
      const standalone = commands.filter(
        (f) => !skillNames.has(path.basename(f.file, '.md')) && f.content.includes('## Task'),
      );
      expect(standalone.length).toBeGreaterThan(0);
      for (const command of standalone)
        expect(skillNames.has(path.basename(command.file, '.md'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('shows the AI the skills it must delegate to, and forbids restating them', () => {
    const commands = ARTIFACT_KINDS.find((k) => k.id === 'commands')!;
    expect(commands.dependsOn).toEqual(['skills']);
    const upstream = [
      {
        file: '.claude/skills/ship-widget/SKILL.md',
        content:
          '---\nname: ship-widget\ndescription: Use when shipping a widget.\n---\n\n# Ship\n',
      },
    ];
    const prompt = commands.prompt('digest', upstream);
    expect(prompt).toContain('ship-widget — Use when shipping a widget.');
    expect(prompt).toContain('Restating the skill');
    expect(prompt).toContain('is a failure');
    // With no skills to point at, the commands must stand on their own.
    expect(commands.prompt('digest', [])).not.toContain('DELEGATING command per skill');
  });

  it('makes every reusable prompt self-contained and ready to paste', () => {
    const root = makeProject();
    try {
      const prompts = ARTIFACT_KINDS.find((k) => k.id === 'prompts')!.fallback(
        analyzeProject(root),
      );
      for (const file of prompts) {
        for (const heading of ['## When to use', '## Context', '## Task', '## Output'])
          expect(file.content, file.file).toContain(heading);
        // A placeholder block the developer fills in before pasting.
        expect(file.content, file.file).toMatch(/```(diff|text)\n<[^>]+>\n```/);
        // Context is stated as facts, so the prompt works without the kit.
        expect(file.content).toContain('demo-app');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cross-links the docs suite and grounds conventions in real files', () => {
    const root = makeProject();
    try {
      const docs = ARTIFACT_KINDS.find((k) => k.id === 'docs')!.fallback(analyzeProject(root));
      const byPath = new Map(docs.map((f) => [f.file, f.content]));
      const index = byPath.get('docs/README.md')!;
      // Every generated doc is discoverable from the index.
      for (const file of docs) {
        if (file.file === 'docs/README.md') continue;
        expect(index, file.file).toContain(`(${file.file.replace('docs/', '')})`);
      }
      for (const doc of [
        'docs/architecture.md',
        'docs/conventions.md',
        'docs/engineer-workflow.md',
      ])
        expect(byPath.get(doc), doc).toContain('## Related');
      // Conventions cite a real file from the code map, not a generic claim.
      expect(byPath.get('docs/conventions.md')).toContain('`src/index.ts`');
      expect(byPath.get('docs/engineer-workflow.md')).toContain('## Definition of done');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('states the standards bar and marks unmet ones as adoption steps', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-bare-docs-'));
    try {
      const docs = ARTIFACT_KINDS.find((k) => k.id === 'docs')!.fallback(analyzeProject(bare));
      const standards = docs.find((f) => f.file === 'docs/engineering-standards.md')!.content;
      expect(standards).toContain('## Adoption steps');
      expect(standards).toContain('a gap, not a description of today');
      expect(standards).toContain('automated test suite');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('demands evidence and kit cross-references from every artifact prompt', () => {
    for (const kind of ARTIFACT_KINDS) {
      const prompt = kind.prompt('digest');
      expect(prompt, kind.id).toContain('Ground every non-obvious claim in evidence');
      expect(prompt, kind.id).toContain('.devpilot/rules.md');
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
    // Retry backoff is exercised in router-network.test.ts; here it would
    // only add real seconds of sleep to every failure path.
    setRetryDelayForTests(0);
  });
  afterEach(() => {
    setFetchForTests(null);
    setRetryDelayForTests(null);
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
    // Harness config is part of the default kit; the CI workflow is opt-in.
    expect(written).toContain('.claude/settings.json');
    expect(written).not.toContain('.github/workflows/devpilot-sync.yml');
    // Rules were propagated to every tool's instruction file.
    expect(result.propagated).toContain('CLAUDE.md');
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(true);
    // Slash command uses the real script.
    const testCmd = fs.readFileSync(path.join(root, '.claude/commands/test.md'), 'utf8');
    expect(testCmd).toContain('npm run test');
    // The working agreement reaches every tool through the rules mirror.
    expect(fs.readFileSync(path.join(root, '.devpilot/rules.md'), 'utf8')).toContain(
      '## Working agreement',
    );
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain(
      'Never touch documentation silently',
    );
  });

  it('adds the working agreement to rules the provider wrote without it', async () => {
    openVault().set('anthropic', 'test-key');
    const aiText = [
      '<<<FILE .devpilot/rules.md>>>',
      '## General',
      '',
      '- Keep changes small.',
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
      kinds: ['rules'],
      provider: 'anthropic',
      force: false,
      dryRun: false,
      noAi: false,
    });
    expect(result.files.find((f) => f.file === '.devpilot/rules.md')?.action).toBe('written');
    const written = fs.readFileSync(path.join(root, '.devpilot/rules.md'), 'utf8');
    expect(written.startsWith('## Working agreement')).toBe(true);
    expect(written).toContain('- Keep changes small.');
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

  it('retries a response that invents a script, then reports what it kept', async () => {
    openVault().set('anthropic', 'test-key');
    let calls = 0;
    // demo-app has test/lint/build scripts — "typecheck" is invented.
    const aiText =
      '<<<FILE .devpilot/rules.md>>>\n## General\n- Run `npm run typecheck`.\n<<<END>>>';
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
    expect(calls).toBe(3); // review pass + first attempt + retry
    // The second answer is kept — a missing file helps nobody — but the claim
    // the project contradicts is reported rather than passed off as fact.
    expect(result.files).toContainEqual(
      expect.objectContaining({ file: '.devpilot/rules.md', action: 'written' }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('no "typecheck" script');
  });

  it('accepts a response whose commands and paths all check out, without retrying', async () => {
    openVault().set('anthropic', 'test-key');
    let calls = 0;
    const aiText =
      '<<<FILE .devpilot/rules.md>>>\n## General\n- Run `npm run test` and read `src/index.ts`.\n<<<END>>>';
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
    expect(calls).toBe(2);
    expect(result.issues).toEqual([]);
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
    expect(calls).toBeLessThanOrEqual(3); // review call + its 429 retries
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

describe('dependencyWaves', () => {
  const kind = (id: string, dependsOn?: string[]): ArtifactKind =>
    ({ id, dependsOn }) as unknown as ArtifactKind;
  const ids = (kinds: ArtifactKind[][]): string[][] => kinds.map((w) => w.map((k) => k.id));

  it('runs a dependent kind after the kind it builds on', () => {
    const waves = dependencyWaves([kind('commands', ['skills']), kind('rules'), kind('skills')]);
    expect(ids(waves)).toEqual([['rules', 'skills'], ['commands']]);
  });

  it('does not wait for a dependency that is not part of the run', () => {
    expect(ids(dependencyWaves([kind('commands', ['skills'])]))).toEqual([['commands']]);
  });

  it('keeps every selected kind exactly once, independents in one wave', () => {
    const waves = dependencyWaves([kind('a'), kind('b'), kind('c')]);
    expect(ids(waves)).toEqual([['a', 'b', 'c']]);
  });

  it('does not hang on a dependency cycle', () => {
    const waves = dependencyWaves([kind('a', ['b']), kind('b', ['a'])]);
    expect(ids(waves).flat().sort()).toEqual(['a', 'b']);
  });

  it('orders the real kit so commands see the skills', () => {
    const waves = ids(dependencyWaves(ARTIFACT_KINDS));
    const skills = waves.findIndex((w) => w.includes('skills'));
    const commands = waves.findIndex((w) => w.includes('commands'));
    expect(skills).toBeGreaterThanOrEqual(0);
    expect(commands).toBeGreaterThan(skills);
  });
});

describe('concurrencyFor', () => {
  const spec = (parallel?: number): ProviderSpec =>
    ({ id: 'x', parallel }) as unknown as ProviderSpec;

  it('never pools static generation', () => {
    expect(concurrencyFor(null, 8, 7)).toBe(1);
  });

  it('uses the provider limit, then the default', () => {
    expect(concurrencyFor(spec(2), undefined, 7)).toBe(2);
    expect(concurrencyFor(spec(), undefined, 7)).toBe(3);
  });

  it('lets an explicit override win but never exceeds the work available', () => {
    expect(concurrencyFor(spec(2), 6, 7)).toBe(6);
    expect(concurrencyFor(spec(4), 6, 2)).toBe(2);
  });

  it('falls back to the provider limit for a nonsense override', () => {
    // A NaN here would produce a pool of zero workers and generate nothing.
    expect(concurrencyFor(spec(2), Number.NaN, 7)).toBe(2);
    expect(concurrencyFor(spec(2), 0, 7)).toBe(2);
    expect(concurrencyFor(spec(2), -1, 7)).toBe(2);
  });
});

/* --- shared stubs for the AI-backed pipeline describes below --- */

const aiResponse = (text: string): Response =>
  new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const promptOf = (init: RequestInit | undefined): string =>
  (JSON.parse(init?.body as string) as { messages: { content: string }[] }).messages[0]!.content;

/** The reading pass is the only prompt that asks for a codebase review. */
const isReviewPrompt = (text: string): boolean => text.includes('deep codebase review');

/**
 * A complete, allowed response for whichever kind is being asked for — each
 * kind enforces its own allowedPaths and minFiles, so a stub that ignores
 * them would be retried and skew call counts.
 */
const filesFor = (prompt: string): string => {
  const block = (file: string, body: string): string => `<<<FILE ${file}>>>\n${body}\n<<<END>>>`;
  if (prompt.includes('.devpilot/prompts/')) {
    return [1, 2, 3].map((n) => block(`.devpilot/prompts/p${n}.md`, `# Prompt ${n}`)).join('\n');
  }
  return block('.devpilot/rules.md', '## General\n\n- Be good.');
};

describe('parallel kind generation', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = makeProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-home-par-'));
    process.env.DEVPILOT_HOME = home;
    process.env.DEVPILOT_VAULT = 'file';
    setRetryDelayForTests(0);
    openVault().set('anthropic', 'test-key');
  });
  afterEach(() => {
    setFetchForTests(null);
    setRetryDelayForTests(null);
    delete process.env.DEVPILOT_HOME;
    delete process.env.DEVPILOT_VAULT;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('runs kinds concurrently and still reports them in kind order', async () => {
    let inFlight = 0;
    let peak = 0;
    setFetchForTests(async (_url, init) => {
      const text = promptOf(init);
      if (isReviewPrompt(text)) return aiResponse('# Review');
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return aiResponse(filesFor(text));
    });

    const result = await runGenerate({
      root,
      kinds: ['rules', 'prompts'],
      provider: 'anthropic',
      force: false,
      dryRun: false,
      noAi: false,
      concurrency: 2,
    });

    expect(peak).toBe(2);
    expect(result.failed).toEqual([]);
    // Reporting order follows the requested kinds, not completion order.
    const kinds = result.files.filter((f) => f.kind !== 'scan').map((f) => f.kind);
    expect(kinds[0]).toBe('rules');
    expect(kinds[kinds.length - 1]).toBe('prompts');
  });

  it('propagates rules to tool files even when rules finishes out of order', async () => {
    setFetchForTests(async (_url, init) => {
      const text = promptOf(init);
      if (isReviewPrompt(text)) return aiResponse('# Review');
      // Rules answers last, so propagation cannot depend on call order.
      if (text.includes('.devpilot/rules.md')) await new Promise((r) => setTimeout(r, 20));
      return aiResponse(filesFor(text));
    });
    const result = await runGenerate({
      root,
      kinds: ['prompts', 'rules'],
      provider: 'anthropic',
      force: false,
      dryRun: false,
      noAi: false,
      concurrency: 2,
    });
    expect(result.failed).toEqual([]);
    expect(result.propagated).toContain('CLAUDE.md');
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(true);
  });
});

describe('codebase review cache', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = makeProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-home-cache-'));
    process.env.DEVPILOT_HOME = home;
    process.env.DEVPILOT_VAULT = 'file';
    setRetryDelayForTests(0);
    openVault().set('anthropic', 'test-key');
  });
  afterEach(() => {
    setFetchForTests(null);
    setRetryDelayForTests(null);
    delete process.env.DEVPILOT_HOME;
    delete process.env.DEVPILOT_VAULT;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (extra: Partial<GenerateOptions> = {}) =>
    runGenerate({
      root,
      kinds: ['prompts'],
      provider: 'anthropic',
      force: true,
      dryRun: false,
      noAi: false,
      ...extra,
    });

  const stubProvider = (): { reviewCalls: () => number } => {
    let reviewCalls = 0;
    setFetchForTests(async (_url, init) => {
      const text = promptOf(init);
      if (isReviewPrompt(text)) {
        reviewCalls++;
        return aiResponse('# Review\n\nAll good.');
      }
      return aiResponse(filesFor(text));
    });
    return { reviewCalls: () => reviewCalls };
  };

  it('reuses the review when the digest is unchanged', async () => {
    const { reviewCalls } = stubProvider();
    // The first run writes the kit, which itself changes the project — so the
    // digest only settles from the second run on.
    expect((await run()).reviewFromCache).toBe(false);
    await run();
    const settled = await run();
    expect(settled.reviewFromCache).toBe(true);
    expect(reviewCalls()).toBe(2);
    // The cached review still lands in the kit.
    expect(fs.existsSync(path.join(root, '.devpilot/docs/codebase-review.md'))).toBe(true);
  });

  it('re-reads the codebase when --no-cache is passed', async () => {
    const { reviewCalls } = stubProvider();
    await run();
    await run();
    const before = reviewCalls();
    const forced = await run({ noCache: true });
    expect(forced.reviewFromCache).toBe(false);
    expect(reviewCalls()).toBe(before + 1);
  });

  it('re-reads the codebase once the project changes', async () => {
    const { reviewCalls } = stubProvider();
    await run();
    await run();
    const before = reviewCalls();
    fs.writeFileSync(path.join(root, 'src', 'brand-new.ts'), 'export const added = 1;\n');
    const afterEdit = await run();
    expect(afterEdit.reviewFromCache).toBe(false);
    expect(reviewCalls()).toBe(before + 1);
  });

  it('keeps the cache out of the target project', async () => {
    stubProvider();
    await run();
    expect(fs.existsSync(path.join(home, 'cache', 'reviews'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.devpilot', 'cache'))).toBe(false);
  });
});

describe('estimateGenerate', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = makeProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-home-est-'));
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

  it('makes no AI call and counts one call per kind plus the review', () => {
    openVault().set('anthropic', 'test-key');
    setFetchForTests(() => {
      throw new Error('estimate must never reach the network');
    });
    const est = estimateGenerate({
      root,
      kinds: ['rules', 'prompts'],
      provider: 'anthropic',
      force: false,
      dryRun: true,
      noAi: false,
    });
    expect(est.calls).toBe(3);
    expect(est.kinds).toEqual(['rules', 'prompts']);
    expect(est.inputTokens).toBeGreaterThan(0);
    expect(est.usdLow).not.toBeNull();
    expect(est.usdHigh! > est.usdLow!).toBe(true);
    expect(est.priceSource).toBe('builtin');
  });

  it('reports no calls and no cost without a provider', () => {
    const est = estimateGenerate({
      root,
      kinds: [],
      force: false,
      dryRun: true,
      noAi: true,
    });
    expect(est.calls).toBe(0);
    expect(est.provider).toBeNull();
    expect(est.usdLow).toBeNull();
  });

  it('reports subscription providers as not billed per token', () => {
    const est = estimateGenerate({
      root,
      kinds: ['rules'],
      provider: 'ollama',
      force: false,
      dryRun: true,
      noAi: false,
    });
    // Ollama is only "available" when its binary is on PATH; either way the
    // estimate must not invent a dollar figure for a local model.
    expect(est.usdLow).toBeNull();
  });
});
