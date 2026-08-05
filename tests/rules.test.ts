import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRules, loadRules, RULE_TARGETS } from '../src/rules/generators.js';

describe('rules generator', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-rules-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates default rules.md on first load', () => {
    const rules = loadRules(tmp);
    expect(rules).toContain('Never commit secrets');
    expect(fs.existsSync(path.join(tmp, '.knowa', 'rules.md'))).toBe(true);
  });

  it('generates a file for every supported tool', () => {
    const written = generateRules(tmp, 'my-app');
    expect(written).toHaveLength(RULE_TARGETS.length);
    expect(fs.existsSync(path.join(tmp, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'GEMINI.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.cursor', 'rules', 'knowa.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.github', 'copilot-instructions.md'))).toBe(true);
  });

  it('propagates custom rules from .knowa/rules.md', () => {
    fs.mkdirSync(path.join(tmp, '.knowa'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.knowa', 'rules.md'), '- Always use tabs\n');
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
