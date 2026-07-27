import fs from 'node:fs';
import path from 'node:path';

/**
 * The single decision point for "should the scanner look at this path?".
 *
 * Everything that walks the *target* project — the analyzer's file walk, the
 * layout tree and the digest's source sampling — goes through one matcher, so
 * the code map, the tree and the file excerpts can never disagree about what
 * counts as part of the project.
 *
 * Three layers, in order:
 *  1. always-ignored directories (VCS/dependency/output dirs, plus DevPilot's
 *     own output) — cheap and unconditional;
 *  2. ecosystem build output, gated on the marker file that proves the
 *     ecosystem is present (`target/` only in a Cargo project, `vendor/` only
 *     in a Go/PHP/Ruby one) — `bin/` and `vendor/` are ordinary source
 *     directories elsewhere, so an unconditional list would silently hide real
 *     code;
 *  3. the project's own `.gitignore` files (and `.git/info/exclude`) — the
 *     authoritative statement of what is generated rather than authored.
 */

/** Directories that are never part of a project's source, in any ecosystem. */
export const ALWAYS_IGNORED_DIRS: ReadonlySet<string> = new Set([
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

/**
 * Build output that shares its name with a plausible source directory. Each
 * entry is only ignored when its ecosystem marker exists at the project root.
 */
const CONDITIONAL_IGNORED_DIRS: { dir: string; markers: string[] }[] = [
  { dir: 'target', markers: ['Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts'] },
  { dir: 'vendor', markers: ['go.mod', 'composer.json', 'Gemfile'] },
  { dir: 'bin', markers: ['.csproj', '.fsproj', '.sln', '.slnx'] },
  { dir: 'obj', markers: ['.csproj', '.fsproj', '.sln', '.slnx'] },
  { dir: 'Pods', markers: ['Podfile'] },
  { dir: 'DerivedData', markers: ['Podfile', 'Package.swift'] },
  { dir: '_build', markers: ['mix.exs'] },
  { dir: 'deps', markers: ['mix.exs'] },
];

/** Dot-entries are skipped, except the ones that carry real project signal. */
const ALLOWED_DOT_ENTRIES: ReadonlySet<string> = new Set(['.github']);

export interface CompiledRule {
  re: RegExp;
  /** Pattern ended with `/` — matches directories only. */
  dirOnly: boolean;
  /** Pattern started with `!` — re-includes a path an earlier rule excluded. */
  negated: boolean;
}

function escapeRegexChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Compile one gitignore pattern. Returns null for blanks and comments.
 * Supports the subset that appears in real .gitignore files: anchoring,
 * directory-only patterns, negation, `*`, `?`, `**` and character classes.
 */
export function compileGitignoreRule(line: string): CompiledRule | null {
  // Trailing whitespace is insignificant unless escaped; leading is not.
  let pattern = line.replace(/(?<!\\)\s+$/, '');
  if (!pattern || pattern.startsWith('#')) return null;

  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
    pattern = pattern.slice(1);
  }
  if (!pattern) return null;

  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.slice(0, -1);
  if (!pattern) return null;

  // A slash anywhere but the (already stripped) end anchors the pattern to the
  // directory holding the .gitignore; otherwise it matches at any depth.
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      body += escapeRegexChar(pattern[++i]!);
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0 || pattern[i - 1] === '/';
        if (atStart && pattern[i + 2] === '/') {
          body += '(?:.*/)?'; // `**/` — zero or more leading directories
          i += 2;
        } else {
          body += '.*'; // `**` elsewhere — cross directory boundaries
          i += 1;
        }
      } else {
        body += '[^/]*';
      }
    } else if (c === '?') {
      body += '[^/]';
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        body += '\\[';
      } else {
        const cls = pattern.slice(i + 1, close).replace(/^!/, '^');
        body += `[${cls}]`;
        i = close;
      }
    } else {
      body += escapeRegexChar(c);
    }
  }

  // An unanchored pattern matches the entry at any depth; either form also
  // matches everything beneath a matched directory.
  const prefix = anchored ? '^' : '^(?:.*/)?';
  try {
    return { re: new RegExp(`${prefix}${body}(?:/.*)?$`), dirOnly, negated };
  } catch {
    return null; // an unparseable pattern must never break a scan
  }
}

function parseRules(content: string): CompiledRule[] {
  const rules: CompiledRule[] = [];
  for (const line of content.split(/\r?\n/)) {
    const rule = compileGitignoreRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

export interface IgnoreMatcher {
  /**
   * True when a project-relative POSIX path should be skipped. Callers test
   * directories before descending into them, which matches git: a path under
   * an excluded directory cannot be re-included.
   */
  ignores(relPath: string, isDir: boolean): boolean;
}

/** A matcher that ignores nothing — for callers scanning an explicit list. */
export const NULL_IGNORE: IgnoreMatcher = { ignores: () => false };

/**
 * Build the ignore matcher for a project root. `.gitignore` files are read
 * lazily per directory and cached, so a walk pays for each one exactly once.
 */
export function createIgnore(root: string): IgnoreMatcher {
  const conditional = new Set<string>();
  let rootEntries: string[] = [];
  try {
    rootEntries = fs.readdirSync(root);
  } catch {
    rootEntries = [];
  }
  for (const { dir, markers } of CONDITIONAL_IGNORED_DIRS) {
    const present = markers.some((m) =>
      m.startsWith('.')
        ? rootEntries.some((e) => e.toLowerCase().endsWith(m.toLowerCase()))
        : rootEntries.includes(m),
    );
    if (present) conditional.add(dir);
  }

  // dir (project-relative POSIX, '' for the root) → its .gitignore rules.
  const rulesByDir = new Map<string, CompiledRule[]>();
  const rulesFor = (dir: string): CompiledRule[] => {
    const cached = rulesByDir.get(dir);
    if (cached) return cached;
    const base = dir ? path.join(root, ...dir.split('/')) : root;
    let rules: CompiledRule[] = [];
    try {
      rules = parseRules(fs.readFileSync(path.join(base, '.gitignore'), 'utf8'));
    } catch {
      rules = [];
    }
    if (!dir) {
      // Repository-local excludes live outside the work tree but bind it.
      try {
        rules = [
          ...rules,
          ...parseRules(fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8')),
        ];
      } catch {
        /* no local excludes — normal */
      }
    }
    rulesByDir.set(dir, rules);
    return rules;
  };

  return {
    ignores(relPath: string, isDir: boolean): boolean {
      const parts = relPath.split('/').filter(Boolean);
      if (parts.length === 0) return false;
      const name = parts[parts.length - 1]!;

      if (isDir && ALWAYS_IGNORED_DIRS.has(name)) return true;
      if (isDir && conditional.has(name)) return true;
      if (name.startsWith('.') && !ALLOWED_DOT_ENTRIES.has(name)) return true;

      // Outer .gitignore files first, inner ones last: the closest file wins,
      // and within one file the last matching rule wins.
      let ignored = false;
      for (let depth = 0; depth < parts.length; depth++) {
        const dir = parts.slice(0, depth).join('/');
        const relToDir = parts.slice(depth).join('/');
        for (const rule of rulesFor(dir)) {
          if (rule.dirOnly && !isDir) continue;
          if (rule.re.test(relToDir)) ignored = !rule.negated;
        }
      }
      return ignored;
    },
  };
}
