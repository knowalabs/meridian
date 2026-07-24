import fs from 'node:fs';
import path from 'node:path';
import { analyzeProject, ProjectAnalysis } from '../scan/analyzer.js';

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

/** Files whose contents say the most about a project, in priority order. */
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
  'Dockerfile',
  'docker-compose.yml',
  'CONTRIBUTING.md',
];

const PER_FILE_CAP = 6_000;
const TOTAL_CAP = 60_000;

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

/** A few extra source files, largest first, to show real code conventions. */
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
        /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|rb|cs|php|swift|vue|svelte|astro|dart|ex|exs|scala)$/i.test(
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
  return picks
    .sort((a, b) => b.size - a.size)
    .slice(0, max)
    .map((p) => p.file);
}

export function buildDigest(root: string, analysis?: ProjectAnalysis): ProjectDigest {
  const a = analysis ?? analyzeProject(root);
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
  ];

  let budget = TOTAL_CAP;
  const files = [...KEY_FILES, ...sampleSources(a, root, 10)];
  const includedFiles: string[] = [];
  for (const rel of files) {
    if (budget <= 0) break;
    const content = excerpt(path.join(root, rel), Math.min(PER_FILE_CAP, budget));
    if (content === null) continue;
    sections.push(`\n## File: ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
    includedFiles.push(rel);
    budget -= content.length;
  }

  return { analysis: a, text: sections.join('\n'), includedFiles };
}
