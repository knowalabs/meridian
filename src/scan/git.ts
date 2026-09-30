import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/exec.js';
import { createIgnore, IgnoreMatcher, ignoresPath } from './ignore.js';

/**
 * Version-control signal for the *target* project: what it has actually been
 * changing, and who has been changing it.
 *
 * Static analysis answers "what is here"; only the history answers "what is
 * live". A file's size says nothing about whether anyone has touched it this
 * year, so a digest sampled by size alone spends its budget on whatever
 * happens to be biggest — often a settled module — while the code under active
 * development goes unread. Churn fixes the ranking, and the recent subjects
 * give the review pass real evidence for the project's trajectory instead of
 * asking it to guess.
 *
 * Read-only and best-effort, exactly like the rest of `src/scan/`: a project
 * without git, without commits, or with a git that errors simply yields
 * `null`, and every consumer treats that as "no signal" rather than a failure.
 */

/** Commits touching one path within the history window. */
export interface GitHotspot {
  file: string;
  commits: number;
}

export interface GitSignal {
  branch: string | null;
  /** Date of the most recent commit, `YYYY-MM-DD`. */
  lastCommit: string | null;
  /** How far back the churn figures below reach. */
  windowDays: number;
  /** Commits in the window (merges excluded), capped by MAX_COMMITS. */
  commits: number;
  /** Distinct authors in the window. */
  contributors: number;
  /** Recent commit subjects, newest first. */
  recent: { date: string; subject: string }[];
  /** Files by commit count in the window, most-changed first. */
  hotspots: GitHotspot[];
  /** Directories by commit count in the window, most-changed first. */
  activeDirs: GitHotspot[];
}

/** How far back churn is measured. Long enough to see a project's direction. */
const WINDOW_DAYS = 180;
/** Commits parsed for churn — bounds both git's work and ours on old repos. */
const MAX_COMMITS = 300;
/** Commit subjects shown to the AI. */
const MAX_RECENT = 25;
/**
 * Files carried in the signal. More than the digest prints, because the rest
 * still rank the sampling — a file at position 40 by churn should outrank an
 * untouched one even when it is not worth a bullet in the report.
 */
const MAX_TRACKED_FILES = 60;
/** Hotspots printed in the rendered section. */
const MAX_HOTSPOTS = 15;
const MAX_ACTIVE_DIRS = 8;
/** No git call may hold up a scan; a slow repo simply contributes no signal. */
const GIT_TIMEOUT_MS = 5_000;

/** Marks the start of a commit record in the churn log's custom format. */
const RECORD = '\u0001';

type GitRunner = (args: string[]) => { ok: boolean; stdout: string };

const defaultRunner: GitRunner = (args) => {
  const res = run('git', args, undefined, { timeoutMs: GIT_TIMEOUT_MS });
  return { ok: res.ok, stdout: res.stdout };
};

let runner: GitRunner | null = null;

/**
 * Test seam for the git subprocess, following the same convention as
 * `setRunForTests` in `src/providers/router.ts`. Pass `null` to restore.
 */
export function setGitForTests(impl: GitRunner | null): void {
  runner = impl;
}

const git = (root: string, args: string[]): { ok: boolean; stdout: string } =>
  (runner ?? defaultRunner)(['-C', root, ...args]);

/**
 * Whether a repository could plausibly cover `root` — a `.git` entry on it or
 * any directory above it (a file, for worktrees and submodules, as readily as
 * a directory).
 *
 * A cheap filesystem answer to a question that would otherwise cost a process
 * spawn on every scan, including the many scans of directories that are
 * plainly not repositories. It only ever short-circuits the "no" case: when a
 * `.git` is found, git itself still decides.
 */
function hasGitDir(root: string): boolean {
  let dir = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Collect the history signal for `root`, or `null` when there is none to
 * collect — no git binary, not a work tree, or a repository without commits.
 *
 * Paths come back relative to `root` rather than to the repository root, so a
 * project scanned from inside a larger monorepo reports its own files.
 */
export function collectGitSignal(
  root: string,
  ignore: IgnoreMatcher = createIgnore(root),
): GitSignal | null {
  // The filesystem gate applies to the real git only: a stubbed runner is the
  // test saying what git would answer, and must not be second-guessed here.
  if (!runner && !hasGitDir(root)) return null;
  if (!git(root, ['rev-parse', '--is-inside-work-tree']).ok) return null;

  const head = git(root, ['log', '-1', '--pretty=format:%cs']);
  // A repository with no commits yet: a work tree, but nothing to learn from.
  if (!head.ok || !head.stdout) return null;

  const branchOut = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const recentOut = git(root, [
    'log',
    '--no-merges',
    `-n${MAX_RECENT}`,
    '--pretty=format:%cs\t%s',
    '--',
    '.',
  ]);
  const recent = recentOut.ok
    ? recentOut.stdout
        .split('\n')
        .flatMap((line) => {
          const [date, ...rest] = line.split('\t');
          const subject = rest.join('\t').trim();
          return date && subject ? [{ date, subject }] : [];
        })
        .slice(0, MAX_RECENT)
    : [];

  // One pass for churn: `--relative` re-bases the file names on `root`, and the
  // record marker separates commits from the file names that belong to them.
  const churnOut = git(root, [
    'log',
    '--no-merges',
    `-n${MAX_COMMITS}`,
    `--since=${WINDOW_DAYS} days ago`,
    '--name-only',
    '--relative',
    `--pretty=format:${RECORD}%an`,
    '--',
    '.',
  ]);

  const perFile = new Map<string, number>();
  const authors = new Set<string>();
  let commits = 0;
  if (churnOut.ok) {
    // Files are counted once per commit: a commit that touches the same path
    // twice is still one change to that path.
    let touched = new Set<string>();
    const flush = (): void => {
      for (const file of touched) perFile.set(file, (perFile.get(file) ?? 0) + 1);
      touched = new Set<string>();
    };
    for (const line of churnOut.stdout.split('\n')) {
      if (line.startsWith(RECORD)) {
        flush();
        commits++;
        const author = line.slice(RECORD.length).trim();
        if (author) authors.add(author);
        continue;
      }
      const file = line.trim();
      // `--relative` prints `../` for paths outside the scanned directory.
      if (file && !file.startsWith('..')) touched.add(file);
    }
    flush();
  }

  // A path that no longer exists, or that the project ignores, is history —
  // not somewhere an assistant should be sent.
  const hotspots: GitHotspot[] = [...perFile]
    .filter(([file]) => !ignoresPath(ignore, file) && fs.existsSync(path.join(root, file)))
    .map(([file, count]) => ({ file, commits: count }))
    .sort((a, b) => b.commits - a.commits || a.file.localeCompare(b.file));

  const perDir = new Map<string, number>();
  for (const { file, commits: count } of hotspots) {
    const dir = path.posix.dirname(file);
    const key = dir === '.' ? '(root files)' : dir.split('/').slice(0, 2).join('/');
    perDir.set(key, (perDir.get(key) ?? 0) + count);
  }
  const activeDirs = [...perDir]
    .map(([file, count]) => ({ file, commits: count }))
    .sort((a, b) => b.commits - a.commits || a.file.localeCompare(b.file))
    .slice(0, MAX_ACTIVE_DIRS);

  return {
    branch: branchOut.ok && branchOut.stdout ? branchOut.stdout.split('\n')[0]! : null,
    lastCommit: head.stdout.split('\n')[0]!,
    windowDays: WINDOW_DAYS,
    commits,
    contributors: authors.size,
    recent,
    hotspots: hotspots.slice(0, MAX_TRACKED_FILES),
    activeDirs,
  };
}

/**
 * One observation of a working tree, compared with a later one to learn which
 * files changed in between — what an agent actually touched, whatever it
 * claims. Each dirty path carries its status plus size and mtime, so a second
 * edit to a file that was already modified still registers.
 */
export interface WorktreeSnapshot {
  head: string | null;
  /** Root-relative POSIX path → fingerprint. Clean files are absent. */
  entries: Map<string, string>;
}

/** Paths from `status --porcelain=v2 -z`, relative to the repository root. */
export function parsePorcelainV2(stdout: string): string[] {
  const paths: string[] = [];
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token) continue;
    const fields = token.split(' ');
    // Fixed fields before the path: ordinary 8, rename/copy 9, unmerged 10.
    const skip = { '1': 8, '2': 9, u: 10 }[fields[0] as '1' | '2' | 'u'];
    if (skip !== undefined) {
      paths.push(fields.slice(skip).join(' '));
      // A rename's original path follows as its own NUL-terminated token; the
      // old name changed too (it stopped existing).
      if (fields[0] === '2' && tokens[i + 1] !== undefined) paths.push(tokens[++i]!);
    } else if (fields[0] === '?') {
      paths.push(token.slice(2));
    }
  }
  return paths;
}

/**
 * Snapshot `root`'s working tree, or null when it is not in a git work tree.
 * `--no-optional-locks` keeps this read-only: plain `git status` refreshes the
 * index, which would both write to the scanned project and race an agent
 * running git at the same moment. Porcelain v2 rather than v1 because `run()`
 * trims output, and v1's first record can start with a meaningful space.
 */
export function worktreeSnapshot(root: string): WorktreeSnapshot | null {
  if (!runner && !hasGitDir(root)) return null;
  const prefix = git(root, ['rev-parse', '--show-prefix']);
  if (!prefix.ok) return null;
  const status = git(root, [
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
  ]);
  if (!status.ok) return null;
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const under = prefix.stdout.trim();
  const entries = new Map<string, string>();
  for (const repoPath of parsePorcelainV2(status.stdout)) {
    if (!repoPath.startsWith(under)) continue;
    const rel = repoPath.slice(under.length);
    let fingerprint = 'missing';
    try {
      const stat = fs.statSync(path.join(root, rel));
      fingerprint = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      // Deleted in the working tree; the absence itself is the fingerprint.
    }
    entries.set(rel, fingerprint);
  }
  return { head: head.ok && head.stdout ? head.stdout.trim() : null, entries };
}

/**
 * Files that differ between two snapshots: edited, created, deleted or
 * reverted in between, plus everything in commits made in between — an agent
 * that commits its work leaves a clean tree, and must not look like it did
 * nothing.
 */
export function changedSince(
  root: string,
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
): string[] {
  const changed = new Set<string>();
  for (const key of new Set([...before.entries.keys(), ...after.entries.keys()])) {
    if (before.entries.get(key) !== after.entries.get(key)) changed.add(key);
  }
  if (before.head && after.head && before.head !== after.head) {
    const committed = git(root, [
      'diff',
      '--name-only',
      '--relative',
      `${before.head}..${after.head}`,
      '--',
      '.',
    ]);
    if (committed.ok) {
      for (const line of committed.stdout.split('\n')) if (line.trim()) changed.add(line.trim());
    }
  }
  return [...changed].sort();
}

/** Churn per file, for ranking which files a digest should spend its budget on. */
export function churnMap(signal: GitSignal | null): Map<string, number> {
  return new Map((signal?.hotspots ?? []).map((h) => [h.file, h.commits]));
}

/** The history signal as a digest section, or an empty string when there is none. */
export function renderGitSignal(signal: GitSignal | null): string {
  if (!signal) return '';
  const lines: string[] = [];
  const branch = signal.branch && signal.branch !== 'HEAD' ? `on \`${signal.branch}\`` : '';
  lines.push(
    `Last commit ${signal.lastCommit}${branch ? ` ${branch}` : ''}. ` +
      `${signal.commits} commit${signal.commits === 1 ? '' : 's'} from ` +
      `${signal.contributors} contributor${signal.contributors === 1 ? '' : 's'} ` +
      `in the last ${signal.windowDays} days.`,
  );

  if (signal.activeDirs.length) {
    lines.push(
      '',
      'Where the work is happening (commits per area):',
      ...signal.activeDirs.map((d) => `- ${d.file} — ${d.commits}`),
    );
  }
  if (signal.hotspots.length) {
    lines.push(
      '',
      'Most-changed files (these are the ones under active development):',
      ...signal.hotspots.slice(0, MAX_HOTSPOTS).map((h) => `- ${h.file} — ${h.commits} commits`),
    );
  }
  if (signal.recent.length) {
    lines.push(
      '',
      'Recent commits, newest first:',
      ...signal.recent.map((c) => `- ${c.date} ${c.subject}`),
    );
  }
  return lines.join('\n');
}
