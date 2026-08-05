import fs from 'node:fs';
import path from 'node:path';
import { analyzeProject, ProjectAnalysis, renderCodeMap } from '../scan/analyzer.js';
import { renderWorkspaces } from '../scan/workspaces.js';
import { createIgnore, IgnoreMatcher, ignoresPath } from '../scan/ignore.js';
import { churnMap, collectGitSignal, GitSignal, renderGitSignal } from '../scan/git.js';

/**
 * Project digest (Phase 5): a compact, deterministic text snapshot of the
 * project — analysis summary plus excerpts of the most informative files —
 * small enough to fit any provider's context window.
 */

export interface ProjectDigest {
  analysis: ProjectAnalysis;
  /** Rendered digest text handed to the AI provider. */
  text: string;
  /** Files whose contents made it into the digest, in order. */
  includedFiles: string[];
  /** Version-control signal, or null for a project without usable history. */
  git: GitSignal | null;
}

/**
 * Files whose contents say the most about a project, in priority order.
 * Includes future-signal files (CHANGELOG, ROADMAP, TODO) on purpose: the
 * generated kit should reflect where the project is headed, not only where
 * it is today.
 */
const KEY_FILES = [
  'README.md',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pubspec.yaml',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Makefile',
  'CMakeLists.txt',
  'requirements.txt',
  'setup.py',
  'manage.py',
  'mix.exs',
  'Package.swift',
  'deno.json',
  'CHANGELOG.md',
  'ROADMAP.md',
  'TODO.md',
  'lib/main.dart',
  'tsconfig.json',
  'src/index.ts',
  'src/index.js',
  'src/main.ts',
  'src/main.py',
  'src/cli.ts',
  'src/app.ts',
  'main.go',
  'src/main.rs',
  'vitest.config.ts',
  'jest.config.js',
  'eslint.config.js',
  '.github/workflows/ci.yml',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'Dockerfile',
  'docker-compose.yml',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODEOWNERS',
  '.github/CODEOWNERS',
];

const PER_FILE_CAP = 6_000;
const TOTAL_CAP = 60_000;
/** Never grow past this even for million-token providers — keeps calls fast. */
const MAX_CAP = 400_000;
const MIN_CAP = 20_000;

/**
 * Digest budget (chars) for a provider context window: ~30% of the window at
 * ~4 chars/token, leaving the rest for instructions, the review pass and the
 * response. `buildDigest` clamps the result to sane bounds.
 */
export function digestBudgetFor(contextTokens: number): number {
  return Math.floor(contextTokens * 4 * 0.3);
}

function excerpt(file: string, cap: number): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (raw.includes('\0')) return null; // binary
  return raw.length > cap ? raw.slice(0, cap) + '\n… (truncated)' : raw;
}

const isTestFile = (rel: string): boolean =>
  /(^|\/)(tests?|__tests__|spec)\//i.test(rel) || /\.(test|spec)\.[^.]+$/i.test(rel);

/**
 * Extra source files to show real code conventions. Spread round-robin across
 * top-level directories — most-changed first within each, size breaking ties —
 * so one big folder can't crowd out the rest, and guarantee test files a seat:
 * they document intended behavior and the project's test style, which the
 * generated artifacts must describe.
 *
 * Churn leads the ranking on purpose. Size says which file is biggest; only
 * the history says which file the team is actually working in, and that is the
 * one an assistant will be asked to change.
 */
function sampleSources(
  analysis: ProjectAnalysis,
  root: string,
  max: number,
  ignore: IgnoreMatcher,
  churn: Map<string, number>,
): string[] {
  const seen = new Set(KEY_FILES);
  const picks: { file: string; size: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || picks.length > 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (ignore.ignores(rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (
        /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|rb|cs|php|swift|vue|svelte|astro|dart|ex|exs|scala|c|cc|cpp|h|hpp|m|mm|erl|hs|lua|r|zig)$/i.test(
          entry.name,
        ) &&
        !seen.has(rel)
      ) {
        try {
          picks.push({ file: rel, size: fs.statSync(full).size });
        } catch {
          /* unreadable — skip */
        }
      }
    }
  };
  walk(root, 0);

  // In a monorepo the interesting boundary is the package, not the top-level
  // directory — grouping by `packages/` would put every package in one bucket
  // and let the largest one crowd the others out of the digest entirely.
  const packagePaths = (analysis.workspaces?.packages ?? [])
    .map((p) => p.path)
    .sort((a, b) => b.length - a.length);
  const groupOf = (file: string): string =>
    packagePaths.find((dir) => file === dir || file.startsWith(`${dir}/`)) ?? file.split('/')[0]!;

  const groups = new Map<string, { file: string; size: number }[]>();
  for (const p of picks) {
    const key = groupOf(p.file);
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }
  const lists = [...groups.values()];
  for (const list of lists)
    list.sort((a, b) => (churn.get(b.file) ?? 0) - (churn.get(a.file) ?? 0) || b.size - a.size);

  const ordered: string[] = [];
  for (let round = 0; ordered.length < picks.length; round++) {
    for (const list of lists) {
      const pick = list[round];
      if (pick) ordered.push(pick.file);
    }
  }

  const chosen = ordered.slice(0, max);
  if (!chosen.some(isTestFile)) {
    for (const file of ordered.slice(max)) {
      if (isTestFile(file)) {
        if (chosen.length >= max) chosen.pop();
        chosen.push(file);
        break;
      }
    }
  }
  return chosen;
}

export function buildDigest(
  root: string,
  analysis?: ProjectAnalysis,
  budgetChars?: number,
): ProjectDigest {
  const cap = Math.min(MAX_CAP, Math.max(MIN_CAP, budgetChars ?? TOTAL_CAP));
  const perFileCap = Math.min(12_000, Math.max(PER_FILE_CAP, Math.floor(cap / 15)));
  const sampleMax = Math.max(10, Math.min(40, Math.floor(cap / 12_000)));
  // One matcher for the whole digest: the analysis, the layout tree and the
  // sampled excerpts must agree on what belongs to the project.
  const ignore = createIgnore(root);
  const a = analysis ?? analyzeProject(root, ignore);
  // History is read once and used twice: as a section the AI reads, and as the
  // ranking that decides which files are worth the excerpt budget below.
  const git = collectGitSignal(root, ignore);
  const churn = churnMap(git);
  // The code map goes in ahead of file excerpts: every class/function in the
  // project stays visible to the AI even when file contents don't fit.
  const codeMapText = renderCodeMap(a.codeMap, Math.min(24_000, Math.floor(cap / 4)));
  const gitText = renderGitSignal(git);
  const sections: string[] = [
    `# Project: ${a.name}`,
    `Languages: ${a.languages.map((l) => `${l.language} (${l.files} files)`).join(', ') || 'unknown'}`,
    `Frameworks/tooling: ${a.frameworks.join(', ') || 'none detected'}`,
    `Conventions: ${a.conventions.join('; ') || 'none detected'}`,
    `Scripts: ${
      Object.entries(a.scripts)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ') || '(none)'
    }`,
    `Dependencies: ${a.dependencies.join(', ') || '(none)'}`,
    `Dev dependencies: ${a.devDependencies.join(', ') || '(none)'}`,
    `\n## Layout\n\n${a.tree}`,
    ...(a.workspaces
      ? [
          `\n## Workspace packages — this repository holds several projects\n\n${renderWorkspaces(a.workspaces)}`,
        ]
      : []),
    `\n## Code map — every class, function and type per file\n\n${codeMapText || '(no symbols detected)'}`,
    ...(gitText
      ? [`\n## Recent activity — what this project is actually working on\n\n${gitText}`]
      : []),
  ];

  let budget = cap - codeMapText.length - gitText.length;
  const files = [...KEY_FILES, ...sampleSources(a, root, sampleMax, ignore, churn)];
  const includedFiles: string[] = [];
  for (const rel of files) {
    if (budget <= 0) break;
    const content = excerpt(path.join(root, rel), Math.min(perFileCap, budget));
    if (content === null) continue;
    sections.push(`\n## File: ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
    includedFiles.push(rel);
    budget -= content.length;
  }

  return { analysis: a, text: sections.join('\n'), includedFiles, git };
}

/* ------------------------- follow-up file requests ------------------------- */

/**
 * The digest is a fixed budget spent on files chosen by heuristic, so the one
 * file that would settle a question about this project may simply not be in
 * it. Rather than let the review pass guess, it may ask: the protocol below
 * lets a response name the files it wants, and `serveFileRequests` reads them
 * back under the same rules the digest itself obeys.
 *
 * Deliberately text-only, not tool-calling — every provider DevPilot supports
 * goes through the same `ask(prompt)` string interface, including the keyless
 * CLIs, and a protocol they all speak is worth more than one only the hosted
 * APIs could use.
 */

export const REQUEST_SPEC = `<<<REQUEST>>>
path/one.ts
path/two.ts
<<<END>>>`;

/** Most files one request round may ask for; the rest are ignored. */
const MAX_REQUESTED = 12;

/** Paths a response asked to see, in order, de-duplicated. */
export function parseFileRequests(response: string): string[] {
  const block = /<<<REQUEST>>>\r?\n([\s\S]*?)\r?\n?<<<END>>>/.exec(response);
  if (!block) return [];
  const paths = block[1]!
    .split('\n')
    // Models list paths as bullets, numbers or backticked spans as readily as
    // bare lines; all of them mean the same thing.
    .map((line) =>
      line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '')
        .replace(/`/g, '')
        .trim(),
    )
    .filter((line) => line && !line.includes(' '));
  return [...new Set(paths)].slice(0, MAX_REQUESTED);
}

export interface ServedFiles {
  /** Rendered `## File:` sections, ready to append to the digest. */
  text: string;
  /** Paths actually served. */
  served: string[];
  /** Paths refused, with the reason — told to the AI so it does not re-ask. */
  refused: { file: string; reason: string }[];
}

/**
 * Read the requested files, subject to the same limits as the digest: inside
 * the project, not ignored, not binary, capped per file and in total. A
 * request is a hint from the AI, never an authority — a path that escapes the
 * project root is refused the same way `isAllowedPath` refuses one on the way
 * out.
 */
export function serveFileRequests(
  root: string,
  requested: string[],
  budgetChars: number,
  ignore: IgnoreMatcher = createIgnore(root),
): ServedFiles {
  const served: string[] = [];
  const refused: { file: string; reason: string }[] = [];
  const sections: string[] = [];
  let budget = budgetChars;

  for (const raw of requested) {
    const rel = path.posix.normalize(raw.replace(/\\/g, '/').replace(/^\.\//, ''));
    if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || rel.startsWith('..')) {
      refused.push({ file: raw, reason: 'outside the project' });
      continue;
    }
    if (budget <= 0) {
      refused.push({ file: raw, reason: 'no budget left this round' });
      continue;
    }
    const full = path.join(root, rel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      refused.push({ file: rel, reason: 'does not exist' });
      continue;
    }
    if (stat.isDirectory()) {
      refused.push({ file: rel, reason: 'is a directory, not a file' });
      continue;
    }
    if (ignoresPath(ignore, rel)) {
      refused.push({ file: rel, reason: 'is ignored by this project' });
      continue;
    }
    const content = excerpt(full, Math.min(PER_FILE_CAP * 2, budget));
    if (content === null) {
      refused.push({ file: rel, reason: 'is not readable text' });
      continue;
    }
    sections.push(`\n## File: ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
    served.push(rel);
    budget -= content.length;
  }

  const notes = refused.length
    ? `\n\nThese could not be served — do not ask for them again:\n` +
      refused.map((r) => `- ${r.file} — ${r.reason}`).join('\n')
    : '';
  const text = served.length
    ? `\n\n--- FILES YOU REQUESTED ---${sections.join('\n')}${notes}`
    : refused.length
      ? `\n\n--- FILES YOU REQUESTED ---${notes}`
      : '';
  return { text, served, refused };
}
