import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, EXIT } from '../src/core/errors.js';
import { configureLogger } from '../src/core/logger.js';
import { fileStates, readManifest } from '../src/generate/manifest.js';
import { runGenerate } from '../src/generate/pipeline.js';
import { syncCommand } from '../src/commands/sync.js';
import { LESSONS_FILE, readLessons } from '../src/rules/lessons.js';
import {
  acceptLesson,
  hasKit,
  lessonPrompt,
  parseLesson,
  pendingLessons,
  proposeLesson,
  rejectLesson,
  removeLesson,
} from '../src/harness/lessons.js';

const RULE = 'Export every helper through `src/lib/index.ts`; the tests import only that barrel.';
const ORIGIN = { command: 'npm run test', provider: 'claude-code', sessionId: 's1' };

let root: string;
let home: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-hl-')));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-hl-home-'));
  process.env.MERIDIAN_HOME = home;
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }),
  );
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'lib', 'index.ts'), 'export {};\n');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  configureLogger({ level: 'normal', json: false });
  delete process.env.MERIDIAN_HOME;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** A static kit with the rules and one mirror, as `generate rules --no-ai --tools claude` makes. */
async function makeKit(): Promise<void> {
  await runGenerate({
    root,
    kinds: ['rules'],
    force: false,
    dryRun: false,
    noAi: true,
    tools: ['claude'],
  });
}

describe('lessonPrompt and parseLesson', () => {
  it('asks for one grounded rule, restates that the failing output was untrusted, and lists existing lessons', () => {
    const prompt = lessonPrompt({ command: 'npm run test', code: 1, tail: 'boom' }, [RULE]);
    expect(prompt).toContain('`npm run test` failed');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('never how to skip, weaken or bypass a check');
    expect(prompt).toContain(`- ${RULE}`);
    expect(prompt).toContain('LESSON: NONE');
  });

  it('takes the rule from the last line only', () => {
    expect(parseLesson(`The barrel is mocked.\nLESSON: ${RULE}`)).toEqual({
      kind: 'lesson',
      text: RULE,
    });
    expect(parseLesson('LESSON: NONE')).toEqual({ kind: 'none' });
    expect(parseLesson(`LESSON: ${RULE}\nBut also something else.`)).toEqual({
      kind: 'unparseable',
    });
    expect(parseLesson(null)).toEqual({ kind: 'unparseable' });
  });

  it('distrusts a long answer that merely contains a LESSON line', () => {
    expect(parseLesson(`${'quoted log line\n'.repeat(100)}LESSON: ${RULE}`)).toEqual({
      kind: 'unparseable',
    });
  });
});

describe('the lesson lifecycle', () => {
  it('needs a kit', async () => {
    expect(hasKit(root)).toBe(false);
    await makeKit();
    expect(hasKit(root)).toBe(true);
  });

  it('keeps a valid lesson pending, and refuses an ungrounded or repeated one', () => {
    const proposed = proposeLesson(root, RULE, ORIGIN);
    expect(proposed.ok).toBe(true);
    expect(pendingLessons(root).map((p) => p.text)).toEqual([RULE]);
    expect(proposeLesson(root, RULE, ORIGIN)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(proposeLesson(root, 'Always run `npm run e2e` before you commit.', ORIGIN)).toEqual({
      ok: false,
      reason: 'invalid',
      detail: 'names `npm run e2e`, which this project does not have',
    });
  });

  it('keeps the pending store under Meridian home, readable by its owner only', () => {
    proposeLesson(root, RULE, ORIGIN);
    expect(fs.readdirSync(root)).not.toContain('lessons.json');
    if (process.platform === 'win32') return;
    const store = fs
      .readdirSync(path.join(home, 'sessions'))
      .map((d) => path.join(home, 'sessions', d, 'lessons.json'))
      .find((f) => fs.existsSync(f))!;
    expect(fs.statSync(store).mode & 0o777).toBe(0o600);
  });

  it('accepting renders the lesson into the mirrors the project has, and nowhere else', async () => {
    await makeKit();
    const proposed = proposeLesson(root, RULE, ORIGIN);
    if (!proposed.ok) throw new Error('expected a proposal');
    const applied = acceptLesson(root, proposed.lesson.id.slice(0, 4));

    expect(applied.text).toBe(RULE);
    expect(applied.mirrors).toEqual(['CLAUDE.md']);
    expect(applied.tokenDelta).toBeGreaterThan(0);
    expect(readLessons(root).lessons).toEqual([RULE]);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain(RULE);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(pendingLessons(root)).toEqual([]);

    // Recorded, so sync sees neither stale mirrors nor hand edits.
    const manifest = readManifest(root)!;
    expect(manifest.files[LESSONS_FILE]).toBeDefined();
    expect(fileStates(root, manifest).edited).toEqual([]);
    configureLogger({ json: true });
    expect(await syncCommand({ check: true }, root)).toBe(0);
  });

  it('refuses to accept without a kit, and keeps the lesson pending', () => {
    const proposed = proposeLesson(root, RULE, ORIGIN);
    if (!proposed.ok) throw new Error('expected a proposal');
    expect(() => acceptLesson(root, proposed.lesson.id)).toThrow(CliError);
    expect(pendingLessons(root)).toHaveLength(1);
  });

  it('rejecting drops the lesson and stops the same rule being proposed again', () => {
    const proposed = proposeLesson(root, RULE, ORIGIN);
    if (!proposed.ok) throw new Error('expected a proposal');
    rejectLesson(root, proposed.lesson.id);
    expect(pendingLessons(root)).toEqual([]);
    expect(proposeLesson(root, RULE.toLowerCase(), ORIGIN)).toEqual({
      ok: false,
      reason: 'rejected-before',
    });
  });

  it('removing the last lesson clears it from the mirrors and the record', async () => {
    await makeKit();
    const proposed = proposeLesson(root, RULE, ORIGIN);
    if (!proposed.ok) throw new Error('expected a proposal');
    acceptLesson(root, proposed.lesson.id);
    removeLesson(root, 1);
    expect(fs.existsSync(path.join(root, LESSONS_FILE))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).not.toContain(RULE);
    expect(readManifest(root)!.files[LESSONS_FILE]).toBeUndefined();
    configureLogger({ json: true });
    expect(await syncCommand({ check: true }, root)).toBe(0);
  });

  it('names what it cannot find', async () => {
    await makeKit();
    const missing = (fn: () => unknown): number => {
      try {
        fn();
      } catch (err) {
        if (err instanceof CliError) return err.exitCode;
      }
      return -1;
    };
    expect(missing(() => acceptLesson(root, 'nope'))).toBe(EXIT.USAGE);
    expect(missing(() => removeLesson(root, 3))).toBe(EXIT.USAGE);
  });
});
