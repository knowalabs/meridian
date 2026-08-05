import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARTIFACT_KINDS } from '../src/generate/artifacts.js';
import { frontmatter, validateArtifacts } from '../src/generate/validate.js';
import { analyzeProject, type ProjectAnalysis } from '../src/scan/analyzer.js';

const kind = (id: string) => ARTIFACT_KINDS.find((k) => k.id === id)!;

const agent = (body: string) => [{ file: '.claude/agents/reviewer.md', content: body }];

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-validate-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', lint: 'eslint src' } }),
  );
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/index.ts'), 'export const app = 1;\n');
  return root;
}

describe('frontmatter', () => {
  it('parses fields and folds YAML list items into their key', () => {
    const fields = frontmatter('---\nname: x\ntools:\n  - Read\n  - Grep\n---\n\nbody\n')!;
    expect(fields['name']).toBe('x');
    expect(fields['tools']).toBe('- Read - Grep');
  });

  it('returns null when there is no frontmatter block', () => {
    expect(frontmatter('# Just a heading\n')).toBeNull();
  });
});

describe('validateArtifacts', () => {
  let root: string;
  let analysis: ProjectAnalysis;
  beforeEach(() => {
    root = makeProject();
    analysis = analyzeProject(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const header =
    '---\nname: reviewer\ndescription: Reviews.\nmodel: sonnet\ntools:\n  - Read\n---\n';

  it('accepts an artifact whose every claim the project supports', () => {
    const files = agent(`${header}\nRun \`npm run test\` and read \`src/index.ts\`.\n`);
    expect(validateArtifacts(kind('agents'), files, analysis, root)).toEqual([]);
  });

  it('rejects a script the project does not have', () => {
    const files = agent(`${header}\nRun \`npm run typecheck\` before committing.\n`);
    const issues = validateArtifacts(kind('agents'), files, analysis, root);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('no "typecheck" script');
  });

  it('says nothing about scripts when the project declares none', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-noscripts-'));
    try {
      const files = agent(`${header}\nRun \`npm run build\`.\n`);
      expect(validateArtifacts(kind('agents'), files, analyzeProject(bare), bare)).toEqual([]);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('flags a path reference that does not exist, but not a kit path or a glob', () => {
    const files = agent(
      `${header}\nRead \`src/missing.ts\`, \`src/index.ts\`, \`docs/architecture.md\`, ` +
        `\`src/**/*.ts\` and @.knowa/rules.md\n`,
    );
    const issues = validateArtifacts(kind('agents'), files, analysis, root);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('src/missing.ts');
    expect(issues[0]!.severity).toBe('warning');
  });

  it('reads a path reference the way a reader would', () => {
    fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/core/vault.ts'), 'export const v = 1;\n');
    const files = agent(
      `${header}
Import specifier quoted from source: \`./core/colorflag.js\`.
Shorthand for a real file: \`core/vault.ts\`.
Outside this project entirely: \`keys/index.json\`.
Genuinely wrong: \`src/core/missing.ts\`.
`,
    );
    const issues = validateArtifacts(kind('agents'), files, analysis, root);
    expect(issues.map((i) => i.message)).toEqual([expect.stringContaining('src/core/missing.ts')]);
  });

  it('lets an adoption step propose a file, but not a plain reference to it', () => {
    const proposal = agent(`${header}\nAdd \`.github/dependabot.yml\` to close this gap.\n`);
    expect(validateArtifacts(kind('agents'), proposal, analysis, root)).toEqual([]);

    // "adding" earlier in the sentence must not excuse a later dead reference.
    const incidental = agent(
      `${header}\nRead this before adding a provider, or touching \`src/router.spec.ts\`.\n`,
    );
    expect(validateArtifacts(kind('agents'), incidental, analysis, root)).toHaveLength(1);
  });

  it('treats a file another kind will write in the same run as existing', () => {
    const files = agent(`${header}\nRead \`config/generated.yml\`.\n`);
    expect(
      validateArtifacts(kind('agents'), files, analysis, root, ['config/generated.yml']),
    ).toEqual([]);
  });

  it('requires an agent header with a valid model and real tool names', () => {
    const missing = validateArtifacts(
      kind('agents'),
      agent('No frontmatter here.\n'),
      analysis,
      root,
    );
    expect(missing[0]!.message).toContain('missing YAML frontmatter');

    const badModel = agent(
      '---\nname: r\ndescription: d\nmodel: turbo\ntools:\n  - Read\n---\nx\n',
    );
    expect(validateArtifacts(kind('agents'), badModel, analysis, root)[0]!.message).toContain(
      'model "turbo"',
    );

    const badTool = agent(
      '---\nname: r\ndescription: d\nmodel: opus\ntools:\n  - Telepathy\n---\nx\n',
    );
    const issues = validateArtifacts(kind('agents'), badTool, analysis, root);
    expect(issues[0]!.message).toContain('"Telepathy"');
    expect(issues[0]!.severity).toBe('error');
  });

  it('wants a description on a command and an argument hint when it reads $ARGUMENTS', () => {
    const noDesc = [{ file: '.claude/commands/x.md', content: '---\nfoo: bar\n---\n\nDo it.\n' }];
    expect(validateArtifacts(kind('commands'), noDesc, analysis, root)[0]!.message).toContain(
      'no description',
    );

    const noHint = [
      {
        file: '.claude/commands/x.md',
        content: '---\ndescription: d\n---\n\nExplain $ARGUMENTS.\n',
      },
    ];
    const issues = validateArtifacts(kind('commands'), noHint, analysis, root);
    expect(issues[0]!.message).toContain('argument-hint');
    expect(issues[0]!.severity).toBe('warning');
  });

  it('leaves kinds without a frontmatter contract alone', () => {
    const docs = [{ file: 'docs/architecture.md', content: '# Architecture\n\nProse.\n' }];
    expect(validateArtifacts(kind('docs'), docs, analysis, root)).toEqual([]);
  });

  it('passes every kind its own static fallback without complaint', () => {
    for (const k of ARTIFACT_KINDS) {
      const files = k.fallback(analysis);
      const errors = validateArtifacts(k, files, analysis, root).filter(
        (i) => i.severity === 'error',
      );
      expect(errors, `${k.id}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
    }
  });
});
