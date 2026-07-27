import fs from 'node:fs';
import path from 'node:path';
import { createIgnore, IgnoreMatcher } from './ignore.js';
import { detectWorkspaces, renderWorkspaces, WorkspaceInfo } from './workspaces.js';

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

/* --------------------------------- code map --------------------------------- */

/**
 * The code map is a per-file outline of the project's symbols — classes,
 * functions, interfaces, types — extracted with line-anchored patterns per
 * language family. It exists so the AI sees every core concept in the
 * project even when a file's contents don't fit the digest budget.
 */
export interface CodeMapEntry {
  /** Project-relative POSIX path. */
  file: string;
  /** Rendered symbols, e.g. "class KeychainVault", "function openVault". */
  symbols: string[];
}

interface SymbolMatcher {
  /** Global, multiline regex: group 1 = kind keyword, group 2 = name. */
  re: RegExp;
  /** Override for the rendered kind when the keyword isn't the right label. */
  kind?: string;
}

const KIND_LABEL: Record<string, string> = {
  def: 'function',
  defp: 'function',
  fn: 'function',
  func: 'function',
  fun: 'function',
  defmodule: 'module',
  defprotocol: 'protocol',
};

const JS_MATCHERS: SymbolMatcher[] = [
  {
    re: /^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(class|function|interface|enum)\s+([A-Za-z0-9_$]+)/gm,
  },
  { re: /^export\s+(?:declare\s+)?(type|const)\s+([A-Za-z0-9_$]+)/gm },
  { re: /^(?:abstract\s+)?(class)\s+([A-Za-z0-9_$]+)/gm },
  { re: /^(?:async\s+)?(function)\s+([A-Za-z0-9_$]+)/gm },
];
const PY_MATCHERS: SymbolMatcher[] = [
  { re: /^(class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm },
  { re: /^(?:async\s+)?(def)\s+([A-Za-z_][A-Za-z0-9_]*)/gm },
];
const GO_MATCHERS: SymbolMatcher[] = [
  { re: /^(func)\s+(?:\([^)]*\)\s+)?([A-Za-z0-9_]+)/gm },
  { re: /^(type)\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/gm },
];
const RUST_MATCHERS: SymbolMatcher[] = [
  { re: /^\s*pub\s+(?:async\s+)?(fn|struct|enum|trait)\s+([A-Za-z0-9_]+)/gm },
];
const JVM_MATCHERS: SymbolMatcher[] = [
  {
    re: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|open\s+|final\s+|abstract\s+|sealed\s+|data\s+|case\s+|static\s+)*(class|interface|enum|object|trait|record|struct)\s+([A-Za-z0-9_]+)/gm,
  },
  { re: /^\s*(?:suspend\s+)?(fun)\s+([A-Za-z0-9_]+)/gm },
];
const SWIFT_MATCHERS: SymbolMatcher[] = [
  {
    re: /^\s*(?:public\s+|open\s+|internal\s+|final\s+)*(class|struct|enum|protocol|extension)\s+([A-Za-z0-9_]+)/gm,
  },
  { re: /^\s*(?:public\s+|open\s+|internal\s+)*(func)\s+([A-Za-z0-9_]+)/gm },
];
const RUBY_MATCHERS: SymbolMatcher[] = [
  { re: /^\s*(class|module)\s+([A-Z][A-Za-z0-9_:]*)/gm },
  { re: /^\s*(def)\s+(?:self\.)?([a-zA-Z_][a-zA-Z0-9_?!]*)/gm },
];
const PHP_MATCHERS: SymbolMatcher[] = [
  { re: /^\s*(?:abstract\s+|final\s+)?(class|interface|trait|function)\s+([A-Za-z0-9_]+)/gm },
];
const DART_MATCHERS: SymbolMatcher[] = [
  { re: /^(?:abstract\s+)?(class|enum|mixin)\s+([A-Za-z0-9_]+)/gm },
];
const ELIXIR_MATCHERS: SymbolMatcher[] = [
  { re: /^\s*(defmodule|defprotocol)\s+([A-Za-z0-9_.]+)/gm },
  { re: /^\s+(def|defp)\s+([a-z_][a-z0-9_?!]*)/gm },
];
const CPP_MATCHERS: SymbolMatcher[] = [
  { re: /^\s*(?:template\s*<[^>]*>\s*)?(class|struct)\s+([A-Za-z0-9_]+)\s*[:{]/gm },
];

const MATCHERS_BY_EXT: Record<string, SymbolMatcher[]> = {
  '.ts': JS_MATCHERS,
  '.tsx': JS_MATCHERS,
  '.js': JS_MATCHERS,
  '.jsx': JS_MATCHERS,
  '.mjs': JS_MATCHERS,
  '.cjs': JS_MATCHERS,
  '.mts': JS_MATCHERS,
  '.cts': JS_MATCHERS,
  '.vue': JS_MATCHERS,
  '.svelte': JS_MATCHERS,
  '.astro': JS_MATCHERS,
  '.py': PY_MATCHERS,
  '.go': GO_MATCHERS,
  '.rs': RUST_MATCHERS,
  '.java': JVM_MATCHERS,
  '.kt': JVM_MATCHERS,
  '.scala': JVM_MATCHERS,
  '.cs': JVM_MATCHERS,
  '.swift': SWIFT_MATCHERS,
  '.rb': RUBY_MATCHERS,
  '.php': PHP_MATCHERS,
  '.dart': DART_MATCHERS,
  '.ex': ELIXIR_MATCHERS,
  '.exs': ELIXIR_MATCHERS,
  '.c': CPP_MATCHERS,
  '.cc': CPP_MATCHERS,
  '.cpp': CPP_MATCHERS,
  '.h': CPP_MATCHERS,
  '.hpp': CPP_MATCHERS,
};

const PER_FILE_SYMBOL_CAP = 30;
/** Skip huge/minified files — they are not hand-written concepts. */
const SYMBOL_FILE_SIZE_CAP = 200_000;
const CODE_MAP_FILE_CAP = 500;

export function extractFileSymbols(content: string, ext: string): string[] {
  const matchers = MATCHERS_BY_EXT[ext.toLowerCase()];
  if (!matchers || !content || content.length > SYMBOL_FILE_SIZE_CAP) return [];
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const { re, kind } of matchers) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (symbols.length >= PER_FILE_SYMBOL_CAP) return symbols;
      const label = `${kind ?? KIND_LABEL[m[1]!] ?? m[1]!} ${m[2]!}`;
      if (!seen.has(label)) {
        seen.add(label);
        symbols.push(label);
      }
    }
  }
  return symbols;
}

/** Render the code map as compact `file: symbols` lines within a char budget. */
export function renderCodeMap(codeMap: CodeMapEntry[], maxChars = 24_000): string {
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const entry of codeMap) {
    const line = `${entry.file}: ${entry.symbols.join(', ')}`;
    if (used + line.length > maxChars) {
      dropped++;
      continue;
    }
    used += line.length + 1;
    lines.push(line);
  }
  if (dropped) lines.push(`… (+${dropped} more files with symbols)`);
  return lines.join('\n');
}

export interface ProjectAnalysis {
  root: string;
  name: string;
  languages: { language: string; files: number }[];
  dependencies: string[];
  devDependencies: string[];
  frameworks: string[];
  /**
   * Runnable project commands keyed by canonical name (test, lint, build, …).
   * From package.json when it defines scripts; otherwise derived from the
   * ecosystem's own manifests (Makefile, Cargo.toml, go.mod, pyproject, …),
   * in which case each value is the full command to run as-is.
   */
  scripts: Record<string, string>;
  /** Prefix that turns a script name into a command ('npm run ' or ''). */
  scriptRunner: string;
  tree: string;
  conventions: string[];
  apiRoutes: string[];
  /**
   * Per-file symbol outline (classes, functions, interfaces, types) — the
   * project's core concepts, visible to the AI even for files whose
   * contents don't fit the digest.
   */
  codeMap: CodeMapEntry[];
  totalFiles: number;
  /**
   * Package layout when this is a monorepo, else null. Generated artifacts use
   * it to speak about each package instead of an average of all of them.
   */
  workspaces: WorkspaceInfo | null;
}

export function analyzeProject(
  root: string,
  ignore: IgnoreMatcher = createIgnore(root),
): ProjectAnalysis {
  const langCounts = new Map<string, number>();
  const apiRoutes: string[] = [];
  const codeMap: CodeMapEntry[] = [];
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
      const full = path.join(dir, entry.name);
      const relPosix = path.relative(root, full).split(path.sep).join('/');
      if (ignore.ignores(relPosix, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else {
        totalFiles++;
        const rel = path.relative(root, full);
        const ext = path.extname(entry.name).toLowerCase();
        const lang = LANGUAGE_BY_EXT[ext];
        if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
        if (/route|controller|handler|endpoint/i.test(entry.name)) {
          apiRoutes.push(rel);
        }
        if (codeMap.length < CODE_MAP_FILE_CAP && MATCHERS_BY_EXT[ext]) {
          const symbols = extractFileSymbols(readText(full), ext);
          if (symbols.length) codeMap.push({ file: rel.split(path.sep).join('/'), symbols });
        }
      }
    }
  };
  walk(root, 0);
  codeMap.sort((a, b) => a.file.localeCompare(b.file));

  const pkg = readJson<{
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  }>(path.join(root, 'package.json'));

  const workspaces = detectWorkspaces(root, ignore);
  const dependencies = Object.keys(pkg?.dependencies ?? {});
  const devDependencies = Object.keys(pkg?.devDependencies ?? {});
  const npmScripts = pkg?.scripts ?? {};
  const hasNpmScripts = Object.keys(npmScripts).length > 0;

  return {
    root,
    name: pkg?.name ?? path.basename(root),
    languages: [...langCounts.entries()]
      .map(([language, files]) => ({ language, files }))
      .sort((a, b) => b.files - a.files),
    dependencies,
    devDependencies,
    frameworks: [
      ...detectFrameworks(root, [...dependencies, ...devDependencies]),
      ...(workspaces ? [`Monorepo (${workspaces.tool} workspaces)`, ...workspaces.runners] : []),
    ],
    scripts: hasNpmScripts ? npmScripts : detectEcosystemScripts(root),
    scriptRunner: hasNpmScripts ? 'npm run ' : '',
    tree: renderTree(root, ignore),
    conventions: detectConventions(root, devDependencies),
    apiRoutes: apiRoutes.slice(0, 30),
    codeMap,
    totalFiles,
    workspaces,
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
  if (fs.existsSync(path.join(root, 'manage.py'))) found.push('Django');
  if (fs.existsSync(path.join(root, 'composer.json'))) {
    found.push('PHP (Composer)');
    if (readText(path.join(root, 'composer.json')).includes('laravel/framework'))
      found.push('Laravel');
  }
  if (fs.existsSync(path.join(root, 'Gemfile'))) {
    found.push('Ruby (Bundler)');
    if (/^\s*gem ['"]rails['"]/m.test(readText(path.join(root, 'Gemfile'))))
      found.push('Ruby on Rails');
  }
  if (fs.existsSync(path.join(root, 'mix.exs'))) found.push('Elixir (Mix)');
  if (fs.existsSync(path.join(root, 'Package.swift'))) found.push('Swift (SwiftPM)');
  if (fs.existsSync(path.join(root, 'deno.json')) || fs.existsSync(path.join(root, 'deno.jsonc')))
    found.push('Deno');
  if (hasDotnetProject(root)) found.push('.NET');
  if (fs.existsSync(path.join(root, 'pom.xml'))) found.push('Java (Maven)');
  if (
    fs.existsSync(path.join(root, 'build.gradle')) ||
    fs.existsSync(path.join(root, 'build.gradle.kts'))
  )
    found.push('JVM (Gradle)');
  if (fs.existsSync(path.join(root, 'Dockerfile'))) found.push('Docker');
  return found;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** True when the root holds a .NET project/solution file. */
function hasDotnetProject(root: string): boolean {
  try {
    return fs.readdirSync(root).some((f) => /\.(csproj|fsproj|sln|slnx)$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Runnable commands (canonical name → full command) for projects without npm
 * scripts, derived from the manifests each ecosystem actually uses. A
 * Makefile target wins over the ecosystem default for the same name — it
 * encodes the project's preferred workflow.
 */
function detectEcosystemScripts(root: string): Record<string, string> {
  const scripts: Record<string, string> = {};
  const exists = (f: string) => fs.existsSync(path.join(root, f));
  const add = (name: string, command: string): void => {
    if (!scripts[name]) scripts[name] = command;
  };

  const makefile = readText(path.join(root, 'Makefile'));
  for (const match of makefile.matchAll(/^([A-Za-z0-9_-]+):(?!=)/gm)) {
    const target = match[1]!;
    if (/^(test|build|lint|fmt|format|check|typecheck|dev|run|e2e|coverage)$/.test(target)) {
      add(target === 'fmt' ? 'format' : target, `make ${target}`);
    }
  }

  if (exists('Cargo.toml')) {
    add('build', 'cargo build');
    add('test', 'cargo test');
    add('lint', 'cargo clippy');
    add('format', 'cargo fmt');
  }
  if (exists('go.mod')) {
    add('build', 'go build ./...');
    add('test', 'go test ./...');
    add('lint', 'go vet ./...');
    add('format', 'gofmt -w .');
  }
  if (exists('pyproject.toml') || exists('requirements.txt')) {
    const py =
      readText(path.join(root, 'pyproject.toml')) + readText(path.join(root, 'requirements.txt'));
    if (py.includes('pytest') || exists('pytest.ini')) add('test', 'pytest');
    if (py.includes('ruff')) {
      add('lint', 'ruff check .');
      add('format', 'ruff format .');
    }
    if (py.includes('black')) add('format', 'black .');
    if (py.includes('mypy')) add('typecheck', 'mypy .');
  }
  if (exists('manage.py')) {
    add('test', 'python manage.py test');
    add('dev', 'python manage.py runserver');
  }
  if (exists('pubspec.yaml')) {
    const tool = readText(path.join(root, 'pubspec.yaml')).includes('flutter') ? 'flutter' : 'dart';
    add('test', `${tool} test`);
    add('lint', `${tool} analyze`);
    add('format', 'dart format .');
  }
  if (exists('mix.exs')) {
    add('build', 'mix compile');
    add('test', 'mix test');
    add('format', 'mix format');
  }
  if (exists('Package.swift')) {
    add('build', 'swift build');
    add('test', 'swift test');
  }
  if (exists('deno.json') || exists('deno.jsonc')) {
    add('test', 'deno test');
    add('lint', 'deno lint');
    add('format', 'deno fmt');
  }
  if (hasDotnetProject(root)) {
    add('build', 'dotnet build');
    add('test', 'dotnet test');
    add('format', 'dotnet format');
  }
  if (exists('pom.xml')) {
    add('build', 'mvn package');
    add('test', 'mvn test');
  }
  if (exists('build.gradle') || exists('build.gradle.kts')) {
    const gradle = exists('gradlew') ? './gradlew' : 'gradle';
    add('build', `${gradle} build`);
    add('test', `${gradle} test`);
  }
  if (exists('Gemfile')) {
    const gemfile = readText(path.join(root, 'Gemfile'));
    if (gemfile.includes('rspec')) add('test', 'bundle exec rspec');
    if (gemfile.includes('rubocop')) add('lint', 'bundle exec rubocop');
    if (gemfile.includes('rails')) add('dev', 'bin/rails server');
  }
  if (exists('composer.json')) {
    const composer = readJson<{ scripts?: Record<string, unknown> }>(
      path.join(root, 'composer.json'),
    );
    for (const name of Object.keys(composer?.scripts ?? {})) {
      if (/^(test|lint|format|check|build)$/.test(name)) add(name, `composer ${name}`);
    }
  }
  return scripts;
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
  if (exists('.gitlab-ci.yml')) conventions.push('GitLab CI');
  if (exists('Jenkinsfile')) conventions.push('Jenkins CI');
  if (exists('.circleci/config.yml')) conventions.push('CircleCI');
  if (exists('azure-pipelines.yml')) conventions.push('Azure Pipelines');
  if (exists('CODEOWNERS') || exists('.github/CODEOWNERS'))
    conventions.push('Code ownership (CODEOWNERS)');
  return conventions;
}

/** Render a compact top-two-levels directory tree. */
export function renderTree(root: string, ignore: IgnoreMatcher = createIgnore(root)): string {
  const lines: string[] = [path.basename(root) + '/'];
  const level = (dir: string, prefix: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(
          (e) =>
            !ignore.ignores(
              path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'),
              e.isDirectory(),
            ),
        )
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
${
  a.workspaces
    ? `
## Workspace packages

This repository is a ${a.workspaces.tool} workspace. Treat each package as its
own unit — its commands run from its own directory.

\`\`\`
${renderWorkspaces(a.workspaces)}
\`\`\`
`
    : ''
}
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

## Code Map

Classes, functions and types per file — the project's core concepts.

\`\`\`
${renderCodeMap(a.codeMap, 16_000) || '(no symbols detected)'}
\`\`\`
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
