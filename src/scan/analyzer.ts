import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.devpilot',
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript (React)',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript (React)',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.c': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.h': 'C/C++ header',
  '.hpp': 'C++',
  '.sh': 'Shell',
  '.sql': 'SQL',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.astro': 'Astro',
  '.dart': 'Dart',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'CSS (SCSS)',
  '.less': 'CSS (Less)',
  '.scala': 'Scala',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.erl': 'Erlang',
  '.hs': 'Haskell',
  '.lua': 'Lua',
  '.r': 'R',
  '.zig': 'Zig',
  '.m': 'Objective-C',
  '.mm': 'Objective-C++',
};

export interface ProjectAnalysis {
  root: string;
  name: string;
  languages: { language: string; files: number }[];
  dependencies: string[];
  devDependencies: string[];
  frameworks: string[];
  scripts: Record<string, string>;
  tree: string;
  conventions: string[];
  apiRoutes: string[];
  totalFiles: number;
}

export function analyzeProject(root: string): ProjectAnalysis {
  const langCounts = new Map<string, number>();
  const apiRoutes: string[] = [];
  let totalFiles = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else {
        totalFiles++;
        const lang = LANGUAGE_BY_EXT[path.extname(entry.name).toLowerCase()];
        if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
        if (/route|controller|handler|endpoint/i.test(entry.name)) {
          apiRoutes.push(path.relative(root, path.join(dir, entry.name)));
        }
      }
    }
  };
  walk(root, 0);

  const pkg = readJson<{
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  }>(path.join(root, 'package.json'));

  const dependencies = Object.keys(pkg?.dependencies ?? {});
  const devDependencies = Object.keys(pkg?.devDependencies ?? {});

  return {
    root,
    name: pkg?.name ?? path.basename(root),
    languages: [...langCounts.entries()]
      .map(([language, files]) => ({ language, files }))
      .sort((a, b) => b.files - a.files),
    dependencies,
    devDependencies,
    frameworks: detectFrameworks(root, [...dependencies, ...devDependencies]),
    scripts: pkg?.scripts ?? {},
    tree: renderTree(root),
    conventions: detectConventions(root, devDependencies),
    apiRoutes: apiRoutes.slice(0, 30),
    totalFiles,
  };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function detectFrameworks(root: string, deps: string[]): string[] {
  const found: string[] = [];
  const has = (d: string) => deps.includes(d);
  if (has('next')) found.push('Next.js');
  if (has('react') && !has('next')) found.push('React');
  if (has('vue')) found.push('Vue');
  if (has('svelte')) found.push('Svelte');
  if (has('express')) found.push('Express');
  if (has('fastify')) found.push('Fastify');
  if (has('nestjs') || has('@nestjs/core')) found.push('NestJS');
  if (has('commander') || has('oclif')) found.push('CLI (Commander/oclif)');
  if (has('electron')) found.push('Electron');
  if (has('vitest')) found.push('Vitest');
  if (has('jest')) found.push('Jest');
  if (has('@angular/core')) found.push('Angular');
  if (has('astro')) found.push('Astro');
  if (has('tailwindcss')) found.push('Tailwind CSS');
  if (has('vite')) found.push('Vite');
  if (fs.existsSync(path.join(root, 'go.mod'))) found.push('Go module');
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) found.push('Rust (Cargo)');
  if (fs.existsSync(path.join(root, 'pyproject.toml'))) found.push('Python (pyproject)');
  if (fs.existsSync(path.join(root, 'requirements.txt'))) found.push('Python (pip)');
  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) found.push('Flutter/Dart (pubspec)');
  if (fs.existsSync(path.join(root, 'composer.json'))) found.push('PHP (Composer)');
  if (fs.existsSync(path.join(root, 'Gemfile'))) found.push('Ruby (Bundler)');
  if (fs.existsSync(path.join(root, 'pom.xml'))) found.push('Java (Maven)');
  if (
    fs.existsSync(path.join(root, 'build.gradle')) ||
    fs.existsSync(path.join(root, 'build.gradle.kts'))
  )
    found.push('JVM (Gradle)');
  if (fs.existsSync(path.join(root, 'Dockerfile'))) found.push('Docker');
  return found;
}

function detectConventions(root: string, devDeps: string[]): string[] {
  const conventions: string[] = [];
  const exists = (f: string) => fs.existsSync(path.join(root, f));
  if (exists('tsconfig.json')) conventions.push('TypeScript project (tsconfig.json)');
  if (devDeps.includes('eslint') || exists('eslint.config.js') || exists('.eslintrc.json'))
    conventions.push('Linting with ESLint');
  if (devDeps.includes('prettier') || exists('.prettierrc.json') || exists('.prettierrc'))
    conventions.push('Formatting with Prettier');
  if (devDeps.includes('vitest')) conventions.push('Tests with Vitest');
  if (devDeps.includes('jest')) conventions.push('Tests with Jest');
  if (exists('.editorconfig')) conventions.push('EditorConfig');
  if (exists('.github')) conventions.push('GitHub workflows / CI');
  return conventions;
}

/** Render a compact top-two-levels directory tree. */
export function renderTree(root: string): string {
  const lines: string[] = [path.basename(root) + '/'];
  const level = (dir: string, prefix: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
        .sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
        )
        .slice(0, 25);
    } catch {
      return;
    }
    entries.forEach((entry, i) => {
      const last = i === entries.length - 1;
      lines.push(
        `${prefix}${last ? '└── ' : '├── '}${entry.name}${entry.isDirectory() ? '/' : ''}`,
      );
      if (entry.isDirectory())
        level(path.join(dir, entry.name), prefix + (last ? '    ' : '│   '), depth + 1);
    });
  };
  level(root, '', 1);
  return lines.join('\n');
}

/* ------------------------------ markdown output ------------------------------ */

export function renderContextMarkdown(a: ProjectAnalysis): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none detected)';
  return `# ${a.name} — AI Context

> Generated by \`devpilot generate\`. Give this file to AI coding assistants for instant project context.

## Overview

- **Project:** ${a.name}
- **Files scanned:** ${a.totalFiles}
- **Primary languages:** ${a.languages.map((l) => `${l.language} (${l.files})`).join(', ') || 'unknown'}
- **Frameworks / tooling:** ${a.frameworks.join(', ') || 'none detected'}

## Folder Structure

\`\`\`
${a.tree}
\`\`\`

## Dependencies

${list(a.dependencies)}

### Dev dependencies

${list(a.devDependencies)}

## Scripts

${
  Object.entries(a.scripts)
    .map(([k, v]) => `- \`${k}\`: \`${v}\``)
    .join('\n') || '- (none)'
}

## Coding Conventions

${list(a.conventions)}

## API Surface

${list(a.apiRoutes.map((r) => `\`${r}\``))}
`;
}

export function renderArchitectureMarkdown(a: ProjectAnalysis): string {
  return `# ${a.name} — Architecture Summary

> Generated by \`devpilot generate\`.

## Stack

- Languages: ${a.languages.map((l) => l.language).join(', ') || 'unknown'}
- Frameworks: ${a.frameworks.join(', ') || 'none detected'}

## Layout

\`\`\`
${a.tree}
\`\`\`

## Notes

Update this file with system diagrams, data flow and module boundaries as the
project evolves — AI assistants read it via .devpilot/.
`;
}
