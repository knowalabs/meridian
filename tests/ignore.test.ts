import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileGitignoreRule, createIgnore } from '../src/scan/ignore.js';
import { analyzeProject } from '../src/scan/analyzer.js';

describe('compileGitignoreRule', () => {
  const matches = (pattern: string, rel: string, isDir = false): boolean => {
    const rule = compileGitignoreRule(pattern);
    if (!rule) return false;
    if (rule.dirOnly && !isDir) return false;
    return rule.re.test(rel);
  };

  it('ignores blanks and comments', () => {
    expect(compileGitignoreRule('')).toBeNull();
    expect(compileGitignoreRule('   ')).toBeNull();
    expect(compileGitignoreRule('# a comment')).toBeNull();
  });

  it('matches an unanchored name at any depth', () => {
    expect(matches('secrets.txt', 'secrets.txt')).toBe(true);
    expect(matches('secrets.txt', 'a/b/secrets.txt')).toBe(true);
  });

  it('anchors patterns containing a slash', () => {
    expect(matches('src/generated', 'src/generated', true)).toBe(true);
    expect(matches('src/generated', 'lib/src/generated', true)).toBe(false);
  });

  it('matches everything under a matched directory', () => {
    expect(matches('build', 'build/x/y.js')).toBe(true);
  });

  it('honors directory-only patterns', () => {
    expect(matches('cache/', 'cache', true)).toBe(true);
    expect(matches('cache/', 'cache')).toBe(false);
  });

  it('supports globs, character classes and **', () => {
    expect(matches('*.log', 'server.log')).toBe(true);
    expect(matches('*.log', 'logs/server.log')).toBe(true);
    expect(matches('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matches('**/fixtures', 'a/b/fixtures', true)).toBe(true);
    expect(matches('file?.txt', 'file1.txt')).toBe(true);
    expect(matches('report[0-9].csv', 'report3.csv')).toBe(true);
  });

  it('marks negations', () => {
    expect(compileGitignoreRule('!keep.txt')?.negated).toBe(true);
  });

  it('never throws on an unparseable pattern', () => {
    expect(() => compileGitignoreRule('[[[')).not.toThrow();
  });
});

describe('createIgnore', () => {
  let tmp: string;
  const write = (rel: string, content = ''): void => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ignore-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('always ignores dependency and output directories', () => {
    const ignore = createIgnore(tmp);
    expect(ignore.ignores('node_modules', true)).toBe(true);
    expect(ignore.ignores('dist', true)).toBe(true);
    expect(ignore.ignores('.meridian', true)).toBe(true);
    expect(ignore.ignores('src', true)).toBe(false);
  });

  it('skips dot-entries but keeps .github', () => {
    const ignore = createIgnore(tmp);
    expect(ignore.ignores('.cache', true)).toBe(true);
    expect(ignore.ignores('.env', false)).toBe(true);
    expect(ignore.ignores('.github', true)).toBe(false);
  });

  it('ignores target/ only in a Cargo project', () => {
    expect(createIgnore(tmp).ignores('target', true)).toBe(false);
    write('Cargo.toml', '[package]\nname = "demo"\n');
    expect(createIgnore(tmp).ignores('target', true)).toBe(true);
  });

  it('ignores vendor/ only in a Go, PHP or Ruby project', () => {
    expect(createIgnore(tmp).ignores('vendor', true)).toBe(false);
    write('go.mod', 'module demo\n');
    expect(createIgnore(tmp).ignores('vendor', true)).toBe(true);
  });

  it('ignores bin/ and obj/ only in a .NET project', () => {
    expect(createIgnore(tmp).ignores('bin', true)).toBe(false);
    write('Demo.csproj', '<Project />');
    const dotnet = createIgnore(tmp);
    expect(dotnet.ignores('bin', true)).toBe(true);
    expect(dotnet.ignores('obj', true)).toBe(true);
  });

  it('applies the root .gitignore', () => {
    write('.gitignore', 'generated/\n*.snap\n');
    const ignore = createIgnore(tmp);
    expect(ignore.ignores('generated', true)).toBe(true);
    expect(ignore.ignores('src/a.snap', false)).toBe(true);
    expect(ignore.ignores('src/a.ts', false)).toBe(false);
  });

  it('lets a negation re-include a file', () => {
    write('.gitignore', '*.log\n!keep.log\n');
    const ignore = createIgnore(tmp);
    expect(ignore.ignores('a.log', false)).toBe(true);
    expect(ignore.ignores('keep.log', false)).toBe(false);
  });

  it('applies nested .gitignore files relative to their own directory', () => {
    write('packages/api/.gitignore', 'fixtures/\n');
    const ignore = createIgnore(tmp);
    expect(ignore.ignores('packages/api/fixtures', true)).toBe(true);
    expect(ignore.ignores('packages/web/fixtures', true)).toBe(false);
  });

  it('reads .git/info/exclude', () => {
    write('.git/info/exclude', 'scratch/\n');
    expect(createIgnore(tmp).ignores('scratch', true)).toBe(true);
  });
});

describe('analyzer honors ignores', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ignore-scan-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps gitignored and build-output files out of the code map and file count', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname = "demo"\n');
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'generated/\n');
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'lib.rs'), 'pub fn real_symbol() {}\n');
    fs.mkdirSync(path.join(tmp, 'target', 'debug'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'target', 'debug', 'build.rs'), 'pub fn build_junk() {}\n');
    fs.mkdirSync(path.join(tmp, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'generated', 'gen.rs'), 'pub fn generated_junk() {}\n');

    const a = analyzeProject(tmp);
    const symbols = a.codeMap.flatMap((e) => e.symbols).join(' ');
    expect(symbols).toContain('real_symbol');
    expect(symbols).not.toContain('build_junk');
    expect(symbols).not.toContain('generated_junk');
    expect(a.tree).not.toContain('target');
    expect(a.tree).not.toContain('generated');
    // Cargo.toml, .gitignore is skipped as a dot-entry, src/lib.rs
    expect(a.totalFiles).toBe(2);
  });
});
