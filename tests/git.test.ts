import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  churnMap,
  collectGitSignal,
  renderGitSignal,
  setGitForTests,
  type GitSignal,
} from '../src/scan/git.js';

/** The commit-record marker `collectGitSignal` asks git to print. */
const R = '';

function makeRepo(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-git-'));
  for (const file of files) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'x\n');
  }
  return root;
}

/**
 * A git that answers from canned output. Keyed on the distinguishing flag of
 * each call `collectGitSignal` makes, so the stub survives argument reordering.
 */
function fakeGit(out: {
  churn?: string;
  recent?: string;
  workTree?: boolean;
  head?: string;
}): void {
  setGitForTests((args) => {
    const line = args.join(' ');
    if (line.includes('--is-inside-work-tree'))
      return { ok: out.workTree !== false, stdout: 'true' };
    if (line.includes('log -1')) return { ok: true, stdout: out.head ?? '2026-08-01' };
    if (line.includes('--abbrev-ref')) return { ok: true, stdout: 'main' };
    if (line.includes('--name-only')) return { ok: true, stdout: out.churn ?? '' };
    return { ok: true, stdout: out.recent ?? '' };
  });
}

describe('collectGitSignal', () => {
  const roots: string[] = [];
  afterEach(() => {
    setGitForTests(null);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const track = (root: string): string => (roots.push(root), root);

  it('returns null outside a work tree', () => {
    fakeGit({ workTree: false });
    expect(collectGitSignal(track(makeRepo(['a.ts'])))).toBeNull();
  });

  it('returns null for a repository with no commits', () => {
    fakeGit({ head: '' });
    expect(collectGitSignal(track(makeRepo(['a.ts'])))).toBeNull();
  });

  it('counts a file once per commit and ranks by churn', () => {
    const root = track(makeRepo(['src/hot.ts', 'src/cold.ts']));
    fakeGit({
      churn: [
        `${R}Ada`,
        'src/hot.ts',
        // The same path twice in one commit is still one change to it.
        'src/hot.ts',
        `${R}Ada`,
        'src/hot.ts',
        'src/cold.ts',
        `${R}Grace`,
        'src/hot.ts',
      ].join('\n'),
      recent: '2026-08-01\tfeat: warm the hot path',
    });

    const signal = collectGitSignal(root)!;
    expect(signal.commits).toBe(3);
    expect(signal.contributors).toBe(2);
    expect(signal.hotspots).toEqual([
      { file: 'src/hot.ts', commits: 3 },
      { file: 'src/cold.ts', commits: 1 },
    ]);
    expect(signal.activeDirs).toEqual([{ file: 'src', commits: 4 }]);
    expect(signal.recent).toEqual([{ date: '2026-08-01', subject: 'feat: warm the hot path' }]);
    expect(signal.branch).toBe('main');
  });

  it('drops history for files that no longer exist or are ignored', () => {
    const root = track(makeRepo(['src/live.ts', 'node_modules/dep/index.js']));
    fakeGit({
      churn: [
        `${R}Ada`,
        'src/live.ts',
        'src/deleted.ts',
        'node_modules/dep/index.js',
        // `--relative` prints this for history outside the scanned directory.
        '../sibling/other.ts',
      ].join('\n'),
    });

    expect(collectGitSignal(root)!.hotspots).toEqual([{ file: 'src/live.ts', commits: 1 }]);
  });

  it('renders a section naming the active areas and recent work', () => {
    const root = track(makeRepo(['src/a.ts']));
    fakeGit({
      churn: [`${R}Ada`, 'src/a.ts'].join('\n'),
      recent: '2026-08-01\tfix: stop the leak',
    });

    const text = renderGitSignal(collectGitSignal(root));
    expect(text).toContain('Last commit 2026-08-01 on `main`');
    expect(text).toContain('1 commit from 1 contributor');
    expect(text).toContain('src/a.ts — 1 commits');
    expect(text).toContain('fix: stop the leak');
  });

  it('renders nothing without a signal', () => {
    expect(renderGitSignal(null)).toBe('');
    expect(churnMap(null).size).toBe(0);
  });

  it('maps churn for the digest to rank by', () => {
    const signal = {
      hotspots: [
        { file: 'a.ts', commits: 9 },
        { file: 'b.ts', commits: 2 },
      ],
    } as GitSignal;
    expect(churnMap(signal).get('a.ts')).toBe(9);
  });
});

describe('collectGitSignal without a stub', () => {
  it('does not spawn git for a directory no repository covers', () => {
    // The real runner is in play here: a temp directory outside any repository
    // must be answered from the filesystem, not from a process.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-nogit-'));
    try {
      expect(collectGitSignal(root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads this repository’s own history', () => {
    const signal = collectGitSignal(process.cwd());
    expect(signal).not.toBeNull();
    expect(signal!.commits).toBeGreaterThan(0);
    expect(signal!.hotspots.length).toBeGreaterThan(0);
  });
});
