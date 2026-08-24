import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRules, loadRules, RULE_TARGETS, staleMirrors } from '../src/rules/generators.js';
import { detectedAiTools, setToolDetectionForTests } from '../src/plugins/tools.js';
import { mirrorTools } from '../src/generate/pipeline.js';

describe('rules generator', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-rules-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates default rules.md on first load', () => {
    const rules = loadRules(tmp);
    expect(rules).toContain('Never commit secrets');
    expect(fs.existsSync(path.join(tmp, '.meridian', 'rules.md'))).toBe(true);
  });

  it('generates a file for every supported tool', () => {
    const written = generateRules(tmp, 'my-app');
    expect(written).toHaveLength(RULE_TARGETS.length);
    expect(fs.existsSync(path.join(tmp, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'GEMINI.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.cursor', 'rules', 'meridian.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.github', 'copilot-instructions.md'))).toBe(true);
  });

  it('propagates custom rules from .meridian/rules.md', () => {
    fs.mkdirSync(path.join(tmp, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.meridian', 'rules.md'), '- Always use tabs\n');
    generateRules(tmp, 'my-app');
    const claude = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('Always use tabs');
    expect(claude).toContain('my-app');
  });

  it('respects a target filter', () => {
    const written = generateRules(tmp, 'my-app', ['claude']);
    expect(written).toHaveLength(1);
    expect(fs.existsSync(path.join(tmp, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'GEMINI.md'))).toBe(false);
  });
});

describe('staleMirrors', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mirror-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports nothing right after a generate', () => {
    generateRules(root, 'demo');
    expect(staleMirrors(root, 'demo')).toEqual([]);
  });

  it('reports every mirror once .meridian/rules.md is hand-edited', () => {
    generateRules(root, 'demo');
    fs.appendFileSync(path.join(root, '.meridian', 'rules.md'), '\n- Never use tabs.\n');
    expect(staleMirrors(root, 'demo')).toEqual(RULE_TARGETS.map((t) => t.file));
  });

  it('re-mirroring clears it and carries the edit into every tool file', () => {
    generateRules(root, 'demo');
    fs.appendFileSync(path.join(root, '.meridian', 'rules.md'), '\n- Never use tabs.\n');
    generateRules(root, 'demo');
    expect(staleMirrors(root, 'demo')).toEqual([]);
    for (const target of RULE_TARGETS) {
      expect(fs.readFileSync(path.join(root, target.file), 'utf8')).toContain('Never use tabs.');
    }
  });

  it('ignores cosmetic reformatting of a mirror', () => {
    generateRules(root, 'demo');
    const file = path.join(root, 'CLAUDE.md');
    // What a markdown formatter does: line endings and trailing whitespace.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n') + '\n\n');
    expect(staleMirrors(root, 'demo')).toEqual([]);
  });

  it('does not claim a mirror the project never had', () => {
    generateRules(root, 'demo', ['claude']);
    expect(staleMirrors(root, 'demo')).toEqual([]);
  });

  it('is empty when there is no rules file at all', () => {
    expect(staleMirrors(root, 'demo')).toEqual([]);
  });
});

describe('detectedAiTools', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-detect-'));
  });
  afterEach(() => {
    setToolDetectionForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('claims a tool the project already carries config for', () => {
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'GEMINI.md'), '# rules');
    const found = detectedAiTools(root);
    expect(found).toContain('cursor');
    expect(found).toContain('gemini');
  });

  it('claims copilot only from its instruction file, since it has no CLI', () => {
    expect(detectedAiTools(root)).not.toContain('copilot');
    fs.mkdirSync(path.join(root, '.github'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'copilot-instructions.md'), '# rules');
    expect(detectedAiTools(root)).toContain('copilot');
  });

  it('mirrors only to detected tools, and to all of them when none is detected', () => {
    setToolDetectionForTests(() => ['claude']);
    expect(mirrorTools({ root })).toEqual(['claude']);

    setToolDetectionForTests(() => []);
    // A container or CI box has no editors installed and must still get a kit.
    expect(mirrorTools({ root })).toBeUndefined();
  });

  it('lets an explicit --tools list override detection, including "all"', () => {
    setToolDetectionForTests(() => ['claude']);
    expect(mirrorTools({ root, tools: ['cursor', 'gemini'] })).toEqual(['cursor', 'gemini']);
    expect(mirrorTools({ root, tools: ['all'] })).toBeUndefined();
  });
});
