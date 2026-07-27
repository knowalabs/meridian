import fs from 'node:fs';
import path from 'node:path';
import { IgnoreMatcher, NULL_IGNORE } from './ignore.js';

/**
 * Workspace (monorepo) detection.
 *
 * A monorepo analyzed as one flat project produces a kit that describes an
 * average of its packages and none of them: the layout tree stops two levels
 * down, the symbol budget is spread thin, and the generated rules talk about
 * "the project" when the repository is really five of them. Detecting the
 * package boundaries lets the digest name each package, its own commands and
 * its own dependencies, so generated artifacts can reason per package.
 *
 * Read-only, like the rest of `scan/`, and dependency-free: the manifests are
 * parsed only as far as the package list requires.
 */

export type WorkspaceTool = 'npm' | 'pnpm' | 'yarn' | 'lerna' | 'cargo' | 'go';

export interface WorkspacePackage {
  /** Project-relative POSIX path of the package directory. */
  path: string;
  /** Declared package name, falling back to the directory name. */
  name: string;
  /** The package's own runnable commands, when its manifest declares any. */
  scripts: Record<string, string>;
  /** Names of the package's declared runtime dependencies. */
  dependencies: string[];
}

export interface WorkspaceInfo {
  tool: WorkspaceTool;
  /** Extra monorepo tooling detected alongside, e.g. turbo, nx. */
  runners: string[];
  packages: WorkspacePackage[];
}

/** How many packages to enumerate — enough for real repos, bounded for absurd ones. */
const MAX_PACKAGES = 60;

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Expand one workspace glob into the directories that exist — the forms real
 * workspace manifests use: a literal path, a single-star segment such as
 * "packages/star", and a double-star segment matching any depth.
 */
function expandGlob(root: string, pattern: string, ignore: IgnoreMatcher): string[] {
  const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean);
  let current: string[] = [''];

  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of current) {
      const abs = dir ? path.join(root, ...dir.split('/')) : root;
      if (segment === '**') {
        // `**` means this level and every level below it.
        next.push(dir);
        const descend = (rel: string, depth: number): void => {
          if (depth > 4) return;
          for (const entry of listDirs(path.join(root, ...rel.split('/').filter(Boolean)))) {
            const child = rel ? `${rel}/${entry}` : entry;
            if (ignore.ignores(child, true)) continue;
            next.push(child);
            descend(child, depth + 1);
          }
        };
        descend(dir, 0);
      } else if (segment.includes('*')) {
        const re = new RegExp(`^${segment.split('*').map(escapeRegex).join('[^/]*')}$`);
        for (const entry of listDirs(abs)) {
          const child = dir ? `${dir}/${entry}` : entry;
          if (re.test(entry) && !ignore.ignores(child, true)) next.push(child);
        }
      } else {
        const child = dir ? `${dir}/${segment}` : segment;
        if (isDir(path.join(root, ...child.split('/'))) && !ignore.ignores(child, true))
          next.push(child);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current.filter(Boolean);
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Read whatever a package directory can tell us about itself. */
function describePackage(root: string, rel: string): WorkspacePackage {
  const dir = path.join(root, ...rel.split('/'));
  const fallbackName = rel.split('/').pop() ?? rel;

  const pkg = readJson<{
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  }>(path.join(dir, 'package.json'));
  if (pkg) {
    return {
      path: rel,
      name: pkg.name ?? fallbackName,
      scripts: pkg.scripts ?? {},
      dependencies: Object.keys(pkg.dependencies ?? {}),
    };
  }

  const cargo = readText(path.join(dir, 'Cargo.toml'));
  if (cargo) {
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(cargo)?.[1];
    return { path: rel, name: name ?? fallbackName, scripts: {}, dependencies: [] };
  }

  const goMod = readText(path.join(dir, 'go.mod'));
  if (goMod) {
    const name = /^module\s+(\S+)/m.exec(goMod)?.[1];
    return { path: rel, name: name ?? fallbackName, scripts: {}, dependencies: [] };
  }

  return { path: rel, name: fallbackName, scripts: {}, dependencies: [] };
}

/** The `packages:` list from pnpm-workspace.yaml, without a YAML dependency. */
function parsePnpmWorkspace(content: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      // Inline form: packages: ["a/*", "b"]
      const inline = /\[(.*)\]/.exec(line)?.[1];
      if (inline) {
        globs.push(...inline.split(',').map(unquote).filter(Boolean));
        inPackages = false;
      }
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+(.+)$/.exec(line)?.[1];
    if (item) globs.push(unquote(item));
    else if (line.trim() !== '') break; // a new top-level key ends the list
  }
  return globs;
}

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '');

/** `members = [...]` under `[workspace]` in a Cargo.toml, including multi-line. */
function parseCargoMembers(content: string): string[] {
  const workspace = /\[workspace\]([\s\S]*?)(?:\n\[|$)/.exec(content)?.[1];
  if (!workspace) return [];
  const members = /members\s*=\s*\[([\s\S]*?)\]/.exec(workspace)?.[1];
  return members ? members.split(',').map(unquote).filter(Boolean) : [];
}

/** `use ./a` and `use ( ./a \n ./b )` directives from a go.work file. */
function parseGoWork(content: string): string[] {
  const paths: string[] = [];
  const block = /use\s*\(([\s\S]*?)\)/.exec(content)?.[1];
  if (block) {
    for (const line of block.split(/\r?\n/)) {
      const item = line.trim();
      if (item && !item.startsWith('//')) paths.push(item);
    }
  }
  for (const m of content.matchAll(/^use\s+(?!\()(\S+)/gm)) paths.push(m[1]!);
  return paths;
}

/**
 * Detect the workspace layout, or null for an ordinary single-package project.
 * The first manifest that declares packages wins — a repo with both a pnpm
 * workspace and a Cargo workspace is described by whichever declares more.
 */
export function detectWorkspaces(
  root: string,
  ignore: IgnoreMatcher = NULL_IGNORE,
): WorkspaceInfo | null {
  const candidates: { tool: WorkspaceTool; globs: string[] }[] = [];

  const pnpm =
    readText(path.join(root, 'pnpm-workspace.yaml')) ||
    readText(path.join(root, 'pnpm-workspace.yml'));
  if (pnpm) candidates.push({ tool: 'pnpm', globs: parsePnpmWorkspace(pnpm) });

  const pkg = readJson<{
    workspaces?: string[] | { packages?: string[] };
    packageManager?: string;
  }>(path.join(root, 'package.json'));
  const declared = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : (pkg?.workspaces?.packages ?? []);
  if (declared.length) {
    const yarn = (pkg?.packageManager ?? '').startsWith('yarn');
    candidates.push({ tool: yarn ? 'yarn' : 'npm', globs: declared });
  }

  const lerna = readJson<{ packages?: string[] }>(path.join(root, 'lerna.json'));
  if (lerna?.packages?.length) candidates.push({ tool: 'lerna', globs: lerna.packages });

  const cargoMembers = parseCargoMembers(readText(path.join(root, 'Cargo.toml')));
  if (cargoMembers.length) candidates.push({ tool: 'cargo', globs: cargoMembers });

  const goWork = parseGoWork(readText(path.join(root, 'go.work')));
  if (goWork.length) candidates.push({ tool: 'go', globs: goWork });

  const runners: string[] = [];
  if (fs.existsSync(path.join(root, 'turbo.json'))) runners.push('Turborepo');
  if (fs.existsSync(path.join(root, 'nx.json'))) runners.push('Nx');
  if (lerna) runners.push('Lerna');

  let best: WorkspaceInfo | null = null;
  for (const { tool, globs } of candidates) {
    const seen = new Set<string>();
    const packages: WorkspacePackage[] = [];
    for (const glob of globs) {
      for (const rel of expandGlob(root, glob, ignore)) {
        if (seen.has(rel) || packages.length >= MAX_PACKAGES) continue;
        seen.add(rel);
        packages.push(describePackage(root, rel));
      }
    }
    if (packages.length && (!best || packages.length > best.packages.length)) {
      best = { tool, runners, packages: packages.sort((a, b) => a.path.localeCompare(b.path)) };
    }
  }
  return best;
}

/** Compact workspace summary for the digest and for .devpilot/context.md. */
export function renderWorkspaces(info: WorkspaceInfo): string {
  const lines = [
    `Workspace: ${info.tool}${info.runners.length ? ` (+ ${info.runners.join(', ')})` : ''} — ${info.packages.length} packages`,
  ];
  for (const p of info.packages) {
    const scripts = Object.keys(p.scripts);
    const deps = p.dependencies.slice(0, 8);
    lines.push(
      `- ${p.name} (${p.path})` +
        (scripts.length ? ` — scripts: ${scripts.join(', ')}` : '') +
        (deps.length
          ? ` — deps: ${deps.join(', ')}${p.dependencies.length > deps.length ? ', …' : ''}`
          : ''),
    );
  }
  return lines.join('\n');
}
