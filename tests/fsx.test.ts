import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupFile, readJsonFile, writeFileAtomic } from '../src/core/fsx.js';

describe('fsx', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-fsx-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('writeFileAtomic', () => {
    it('writes content and creates parent directories', () => {
      const file = path.join(tmp, 'a', 'b', 'out.json');
      writeFileAtomic(file, '{"x":1}');
      expect(fs.readFileSync(file, 'utf8')).toBe('{"x":1}');
    });

    it('replaces an existing file and leaves no temp files behind', () => {
      const file = path.join(tmp, 'out.txt');
      writeFileAtomic(file, 'one');
      writeFileAtomic(file, 'two');
      expect(fs.readFileSync(file, 'utf8')).toBe('two');
      expect(fs.readdirSync(tmp)).toEqual(['out.txt']);
    });
  });

  describe('backupFile', () => {
    it('copies the file to a .bak-<timestamp> sibling', () => {
      const file = path.join(tmp, 'config.json');
      fs.writeFileSync(file, 'original');
      const backup = backupFile(file);
      expect(backup).toMatch(/config\.json\.bak-/);
      expect(fs.readFileSync(backup!, 'utf8')).toBe('original');
      expect(fs.readFileSync(file, 'utf8')).toBe('original');
    });

    it('returns null for a missing file', () => {
      expect(backupFile(path.join(tmp, 'nope.json'))).toBeNull();
    });
  });

  describe('readJsonFile', () => {
    it('reads valid JSON', () => {
      const file = path.join(tmp, 'ok.json');
      fs.writeFileSync(file, '{"a": 1}');
      expect(readJsonFile(file)).toEqual({ ok: true, value: { a: 1 } });
    });

    it('reports missing files', () => {
      expect(readJsonFile(path.join(tmp, 'nope.json'))).toMatchObject({
        ok: false,
        reason: 'missing',
      });
    });

    it('reports malformed JSON without throwing', () => {
      const file = path.join(tmp, 'bad.json');
      fs.writeFileSync(file, '{not json');
      expect(readJsonFile(file)).toMatchObject({ ok: false, reason: 'malformed' });
    });

    it('reports shape-validation failures', () => {
      const file = path.join(tmp, 'wrong.json');
      fs.writeFileSync(file, '[1,2,3]');
      const isObj = (x: unknown): x is Record<string, unknown> =>
        typeof x === 'object' && x !== null && !Array.isArray(x);
      expect(readJsonFile(file, isObj)).toMatchObject({ ok: false, reason: 'invalid' });
    });
  });
});
