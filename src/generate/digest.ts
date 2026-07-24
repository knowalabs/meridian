import fs from 'node:fs';
import path from 'node:path';
import { analyzeProject, ProjectAnalysis, renderCodeMap } from '../scan/analyzer.js';

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
 * top-level directories — largest first within each — so one big folder can't
 * crowd out the rest, and guarantee test files a seat: they document intended
 * behavior and the project's test style, which the generated artifacts must
 * describe.
 */
function sampleSources(analysis: ProjectAnalysis, root: string, max: number): string[] {
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
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'build', 'coverage', 'vendor'].includes(entry.name))
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

  const groups = new Map<string, { file: string; size: number }[]>();
  for (const p of picks) {
    const top = p.file.split('/')[0]!;
    const group = groups.get(top);
    if (group) group.push(p);
    else groups.set(top, [p]);
  }
  const lists = [...groups.values()];
  for (const list of lists) list.sort((a, b) => b.size - a.size);

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
  const a = analysis ?? analyzeProject(root);
  // The code map goes in ahead of file excerpts: every class/function in the
  // project stays visible to the AI even when file contents don't fit.
  const codeMapText = renderCodeMap(a.codeMap, Math.min(24_000, Math.floor(cap / 4)));
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
    `\n## Code map — every class, function and type per file\n\n${codeMapText || '(no symbols detected)'}`,
  ];

  let budget = cap - codeMapText.length;
  const files = [...KEY_FILES, ...sampleSources(a, root, sampleMax)];
  const includedFiles: string[] = [];
  for (const rel of files) {
    if (budget <= 0) break;
    const content = excerpt(path.join(root, rel), Math.min(perFileCap, budget));
    if (content === null) continue;
    sections.push(`\n## File: ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
    includedFiles.push(rel);
    budget -= content.length;
  }

  return { analysis: a, text: sections.join('\n'), includedFiles };
}
