import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandRule, parseRule, readKitPermissions } from '../src/harness/rules.js';
import { policyFor } from '../src/harness/policy.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(settings?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-rules-'));
  roots.push(root);
  if (settings !== undefined) {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings),
    );
  }
  return root;
}

describe('parseRule', () => {
  it('reads a tool with and without a specifier', () => {
    expect(parseRule('Bash(npm run test:*)')).toEqual({
      tool: 'Bash',
      specifier: 'npm run test:*',
    });
    expect(parseRule('Edit')).toEqual({ tool: 'Edit', specifier: null });
    expect(parseRule(' Read(./.env) ')).toEqual({ tool: 'Read', specifier: './.env' });
  });

  it('rejects text that is not a rule', () => {
    expect(parseRule('')).toBeNull();
    expect(parseRule('Bash(unclosed')).toBeNull();
    expect(parseRule('(npm test)')).toBeNull();
  });
});

describe('commandRule', () => {
  it('reads both prefix spellings and exact commands', () => {
    expect(commandRule(parseRule('Bash(npm run test:*)')!)).toEqual({
      prefix: 'npm run test',
      exact: false,
    });
    expect(commandRule(parseRule('Bash(npm run test *)')!)).toEqual({
      prefix: 'npm run test',
      exact: false,
    });
    expect(commandRule(parseRule('Bash(git status)')!)).toEqual({
      prefix: 'git status',
      exact: true,
    });
  });

  it('never turns an allow-everything rule into an allow-list entry', () => {
    expect(commandRule(parseRule('Bash')!)).toBeNull();
    expect(commandRule(parseRule('Bash(*)')!)).toBeNull();
    expect(commandRule(parseRule('Bash(:*)')!)).toBeNull();
  });

  it('ignores rules for other tools', () => {
    expect(commandRule(parseRule('Edit(docs/**)')!)).toBeNull();
  });
});

describe('readKitPermissions', () => {
  it('reads allow, ask and deny, dropping entries that are not rules', () => {
    const root = project({
      permissions: {
        allow: ['Bash(npm run lint)', 42, 'not a rule ('],
        ask: ['Edit(docs/**)'],
        deny: ['Read(./.env)'],
      },
    });
    expect(readKitPermissions(root)).toEqual({
      allow: [{ tool: 'Bash', specifier: 'npm run lint' }],
      ask: [{ tool: 'Edit', specifier: 'docs/**' }],
      deny: [{ tool: 'Read', specifier: './.env' }],
    });
  });

  it('returns null for a missing or malformed settings file', () => {
    expect(readKitPermissions(project())).toBeNull();
    expect(readKitPermissions(project('{ not json'))).toBeNull();
    expect(readKitPermissions(project('[]'))).toBeNull();
  });
});

describe('policyFor', () => {
  it('allows no commands in plan mode', () => {
    const root = project({ permissions: { allow: ['Bash(npm run test)'] } });
    expect(policyFor(root, 'plan', ['npm run test'])).toEqual({
      mode: 'plan',
      allowCommands: [],
      source: 'none',
    });
  });

  it("prefers the kit's reviewed allow list", () => {
    const root = project({
      permissions: { allow: ['Bash(npm run test)', 'Bash(npm run test:*)', 'Bash', 'Edit'] },
    });
    expect(policyFor(root, 'edit', ['npm run lint'])).toEqual({
      mode: 'edit',
      allowCommands: [
        { prefix: 'npm run test', exact: true },
        { prefix: 'npm run test', exact: false },
      ],
      source: 'kit',
    });
  });

  it('falls back to the verify chain for a project without a kit', () => {
    expect(policyFor(project(), 'auto', ['npm run lint'])).toEqual({
      mode: 'auto',
      allowCommands: [
        { prefix: 'npm run lint', exact: true },
        { prefix: 'npm run lint', exact: false },
      ],
      source: 'verify-chain',
    });
    expect(policyFor(project(), 'edit', []).source).toBe('none');
  });
});
