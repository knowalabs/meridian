import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  lessonsAcceptCommand,
  lessonsListCommand,
  lessonsRejectCommand,
  lessonsRemoveCommand,
} from '../src/commands/lessons.js';
import { CliError } from '../src/core/errors.js';
import { configureLogger } from '../src/core/logger.js';
import { runGenerate } from '../src/generate/pipeline.js';
import { proposeLesson } from '../src/harness/lessons.js';

const RULE = 'Keep `src/app.ts` free of top-level awaits; the bundler targets CommonJS.';
const ORIGIN = { command: 'npm run build', provider: 'codex-cli', sessionId: 's1' };

let root: string;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-lc-')));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-lc-home-'));
  process.env.MERIDIAN_HOME = home;
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }),
  );
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export {};\n');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runGenerate({
    root,
    kinds: ['rules'],
    force: false,
    dryRun: false,
    noAi: true,
    tools: ['claude'],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  configureLogger({ level: 'normal', json: false });
  delete process.env.MERIDIAN_HOME;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const lastJson = <T>(): T => JSON.parse(String(logSpy.mock.calls.at(-1)![0])) as T;
const propose = (): string => {
  const res = proposeLesson(root, RULE, ORIGIN);
  if (!res.ok) throw new Error('expected a proposal');
  return res.lesson.id;
};

describe('meridian lessons', () => {
  it('lists accepted and pending lessons', () => {
    const id = propose();
    configureLogger({ json: true });
    lessonsListCommand(root);
    expect(lastJson<{ pending: { id: string }[] }>().pending.map((p) => p.id)).toEqual([id]);
    configureLogger({ json: false });
    lessonsListCommand(root);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Awaiting review (1)');
    expect(out).toContain('from a failing npm run build');
  });

  it('accepts into every mirror the project has, then removes', () => {
    const id = propose();
    configureLogger({ json: true });
    expect(lessonsAcceptCommand(id, root)).toBe(0);
    expect(lastJson<{ accepted: string; mirrors: string[] }>()).toMatchObject({
      accepted: RULE,
      mirrors: ['CLAUDE.md'],
    });
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain(RULE);
    lessonsListCommand(root);
    expect(lastJson<{ accepted: string[] }>().accepted).toEqual([RULE]);
    expect(lessonsRemoveCommand('1', root)).toBe(0);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).not.toContain(RULE);
  });

  it('rejects, and refuses a remove that is not a lesson number', () => {
    const id = propose();
    expect(lessonsRejectCommand(id, root)).toBe(0);
    expect(() => lessonsRemoveCommand('first', root)).toThrow(CliError);
    expect(() => lessonsRemoveCommand('0', root)).toThrow(CliError);
  });
});
