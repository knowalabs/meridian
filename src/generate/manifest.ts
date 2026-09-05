import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectAnalysis } from '../scan/analyzer.js';
import { writeFileAtomic } from '../core/fsx.js';
import { topLevelDirs } from './artifacts.js';
import type { Rigor } from './artifacts.js';

/**
 * Kit manifest (.meridian/manifest.json): what `meridian generate` knew about
 * the project when it wrote the kit, and a hash of every file it wrote.
 * `meridian sync` compares this against a fresh analysis to detect drift
 * (the codebase outgrew the kit) and against the files on disk to detect
 * user edits (which sync must preserve, never overwrite).
 */

export const MANIFEST_FILE = '.meridian/manifest.json';

/** The comparable facts of an analysis — cheap to diff, stable to serialize. */
export interface KitFingerprint {
  languages: string[];
  frameworks: string[];
  scripts: Record<string, string>;
  conventions: string[];
  topLevelDirs: string[];
  apiRoutes: string[];
  /** `name (path)` per workspace package; absent for single-package repos. */
  packages?: string[];
}

export interface KitManifest {
  /** Meridian version that wrote the kit. */
  meridian: string;
  generatedAt: string;
  provider: string | null;
  /**
   * Working-agreement rigour the kit was generated at. Absent on manifests
   * written before `--rigor` existed; `meridian sync` treats that as the default
   * rather than re-deciding, so a refresh never changes a kit's rigour.
   */
  rigor?: Rigor;
  fingerprint: KitFingerprint;
  /**
   * Per generated file, the content signature recorded when it was written
   * (`sig2:<sha256>`). Older manifests hold `sig1:` signatures or, before
   * signatures existed, a bare sha256 of the raw content — `fileStates`
   * reads all three.
   */
  files: Record<string, string>;
}

/** Marks a value as a signature hash rather than a legacy raw-content hash. */
const SIG_PREFIX = 'sig2:';
/** The first signature format, read but no longer written. */
const SIG1_PREFIX = 'sig1:';

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Strip the cosmetic degrees of freedom a formatter owns: line endings,
 * indentation and blank lines, list bullets (`*` vs `-` vs `+`), emphasis
 * markers (`*text*` vs `_text_`), table pipes, cell padding and separator
 * width, escape backslashes, and the spacing inside JSON. What survives is
 * the words the file actually says.
 */
const cosmetic = (content: string): string =>
  content
    // Leading bullets only — a hyphen inside a sentence is content.
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/[*_\\|]/g, '')
    // A table separator is the same separator at any width: Prettier pads
    // `---` out to the column, and every generated doc with a table read as
    // hand-edited the first time it did.
    .replace(/-{2,}/g, '-')
    // Removed, not collapsed: Prettier puts a space after a JSON colon the
    // provider left out, and rewraps prose — collapsing to one space still
    // told those apart from the original.
    .replace(/\s/g, '');

/**
 * The `sig1:` stripping, kept verbatim so a kit generated before `sig2`
 * keeps telling its clean files from its edited ones until the next run
 * re-records them. Never used for a new signature.
 */
const cosmeticV1 = (content: string): string =>
  content
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/[*_\\|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Signature of a generated file, used to tell a real hand edit from a
 * cosmetic rewrite. Projects run their own formatter over the kit after
 * `generate` writes it — Prettier alone rewrites emphasis markers, list
 * bullets, table padding and blank lines. Hashing raw bytes made every kit
 * file read as hand-edited the first time that happened, which silently froze
 * `meridian sync` out of ever refreshing them again.
 *
 * The trade-off is deliberate: an edit that changes nothing but formatting is
 * not preserved by sync. An edit that changes a word is.
 */
export function signatureOf(content: string): string {
  return SIG_PREFIX + hashContent(cosmetic(content));
}

/** True when `content` still matches what the manifest recorded for it. */
function matchesRecorded(recorded: string, content: string): boolean {
  // Older manifests recorded a `sig1:` signature or a bare hash of the raw
  // content; compare in kind so an older kit keeps working until its next
  // generate re-records it.
  if (recorded.startsWith(SIG_PREFIX)) return recorded === signatureOf(content);
  if (recorded.startsWith(SIG1_PREFIX))
    return recorded === SIG1_PREFIX + hashContent(cosmeticV1(content));
  return recorded === hashContent(content);
}

export function fingerprintOf(a: ProjectAnalysis): KitFingerprint {
  return {
    languages: a.languages.map((l) => l.language).sort(),
    frameworks: [...a.frameworks].sort(),
    scripts: Object.fromEntries(Object.entries(a.scripts).sort(([x], [y]) => x.localeCompare(y))),
    conventions: [...a.conventions].sort(),
    topLevelDirs: topLevelDirs(a).sort(),
    apiRoutes: [...a.apiRoutes].sort(),
    packages: a.workspaces?.packages.map((p) => `${p.name} (${p.path})`).sort(),
  };
}

const added = <T>(before: T[], after: T[]): T[] => after.filter((x) => !before.includes(x));

/** Human-readable drift between the recorded and the current fingerprint. */
export function diffFingerprints(before: KitFingerprint, after: KitFingerprint): string[] {
  const drift: string[] = [];
  const list = (label: string, olds: string[], news: string[]): void => {
    for (const x of added(olds, news)) drift.push(`new ${label}: ${x}`);
    for (const x of added(news, olds)) drift.push(`removed ${label}: ${x}`);
  };
  list('language', before.languages, after.languages);
  list('framework', before.frameworks, after.frameworks);
  list('top-level directory', before.topLevelDirs, after.topLevelDirs);
  list('convention/tooling', before.conventions, after.conventions);
  list('API route file', before.apiRoutes, after.apiRoutes);
  // A package added to or dropped from the workspace is real drift: the kit
  // describes packages by name, so it is out of date the moment the set moves.
  list('workspace package', before.packages ?? [], after.packages ?? []);
  const scriptNames = new Set([...Object.keys(before.scripts), ...Object.keys(after.scripts)]);
  for (const name of [...scriptNames].sort()) {
    const b = before.scripts[name];
    const a = after.scripts[name];
    if (b === undefined) drift.push(`new script: ${name} (${a})`);
    else if (a === undefined) drift.push(`removed script: ${name}`);
    else if (a !== b) drift.push(`changed script: ${name} ("${b}" → "${a}")`);
  }
  return drift;
}

export function readManifest(root: string): KitManifest | null {
  try {
    const raw = fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8');
    const parsed = JSON.parse(raw) as KitManifest;
    if (!parsed.fingerprint || typeof parsed.files !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeManifest(root: string, manifest: KitManifest): void {
  writeFileAtomic(path.join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
}

/** How each manifest-tracked file stands on disk right now. */
export interface FileStates {
  /** Unchanged since generation — safe for sync to overwrite. */
  clean: string[];
  /** Hand-edited after generation — sync must preserve these. */
  edited: string[];
  /** Deleted from disk — sync regenerates them. */
  missing: string[];
}

export function fileStates(root: string, manifest: KitManifest): FileStates {
  const states: FileStates = { clean: [], edited: [], missing: [] };
  for (const [file, hash] of Object.entries(manifest.files)) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) {
      states.missing.push(file);
      continue;
    }
    (matchesRecorded(hash, fs.readFileSync(target, 'utf8')) ? states.clean : states.edited).push(
      file,
    );
  }
  return states;
}

/** Rough token count for a piece of generated content (~4 chars per token). */
function tokensOf(content: string): number {
  return Math.round(content.length / 4);
}

/** What a generated kit costs an assistant on every single request. */
export interface ResidentCost {
  /** The rules file the assistant loads in full each turn. */
  rules: number;
  /** Frontmatter descriptions that stay in the system prompt all session. */
  agents: number;
  skills: number;
  commands: number;
  total: number;
}

/**
 * The kit's standing context cost, as opposed to what it cost to generate.
 *
 * `--estimate` answers "what will this run charge me"; nothing answered "what
 * will the result charge me on every request afterwards", which is the number
 * that decides whether a kit is worth its rigour. Descriptions are counted
 * rather than whole files because that is what a tool keeps resident: an
 * agent or skill body is only read when it is invoked.
 */
export function residentCost(root: string): ResidentCost {
  const readIf = (rel: string): string => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return '';
    }
  };
  const descriptions = (dir: string, leaf?: string): number => {
    let total = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(root, dir));
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const rel = leaf ? path.join(dir, entry, leaf) : path.join(dir, entry);
      const match = /^description:\s*(.+)$/m.exec(readIf(rel));
      if (match) total += tokensOf(match[1]!);
    }
    return total;
  };
  const rules = tokensOf(readIf('CLAUDE.md') || readIf(path.join('.meridian', 'rules.md')));
  const agents = descriptions(path.join('.claude', 'agents'));
  const skills = descriptions(path.join('.claude', 'skills'), 'SKILL.md');
  const commands = descriptions(path.join('.claude', 'commands'));
  return { rules, agents, skills, commands, total: rules + agents + skills + commands };
}
