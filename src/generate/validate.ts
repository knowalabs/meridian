import fs from 'node:fs';
import path from 'node:path';
import { ProjectAnalysis } from '../scan/analyzer.js';
import { ArtifactFile, ArtifactKind, frontmatter } from './artifacts.js';
import { createIgnore } from '../scan/ignore.js';

// Re-exported here because frontmatter parsing is part of this module's
// contract; it lives in artifacts.ts so the artifact kinds can read each
// other's output without importing their own validator.
export { frontmatter };

/**
 * Content validation for generated artifacts. `isAllowedPath` guards where a
 * response may write; this guards what the response *says*. Every artifact
 * prompt forbids inventing scripts, files and dependencies, but nothing
 * enforced it — and a kit that confidently tells an assistant to run a script
 * the project does not have is worse than no kit at all.
 *
 * Checks are deliberately conservative: they only fire on claims that can be
 * proven false against the analysis or the filesystem, never on style.
 */

export interface ArtifactIssue {
  file: string;
  /** What is wrong, phrased as the fact that contradicts it. */
  message: string;
  /**
   * Blocking issues make a response count as incomplete, so `generateKind`
   * retries once. Warnings are reported but kept.
   */
  severity: 'error' | 'warning';
}

/** Claude Code tool names an agent may list under `tools:`. */
const KNOWN_TOOLS = new Set([
  'Agent',
  'Bash',
  'BashOutput',
  'Edit',
  'Glob',
  'Grep',
  'KillShell',
  'NotebookEdit',
  'Read',
  'SlashCommand',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]);

const KNOWN_MODELS = new Set(['haiku', 'sonnet', 'opus', 'inherit']);

/** Kit paths a generated file may reference before the run has written them. */
const KIT_PREFIXES = [
  '.devpilot/',
  '.claude/',
  '.cursor/',
  '.github/copilot-instructions.md',
  'docs/',
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'README_AI.md',
];

const isKitPath = (file: string): boolean =>
  KIT_PREFIXES.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

/**
 * Script names the generated content claims the project runs. Only commands
 * that go through a script runner are checked — `npm run x`, `pnpm x`,
 * `yarn x` — because those are the ones whose existence the analysis can
 * actually prove or disprove.
 */
function claimedScripts(content: string): { command: string; script: string }[] {
  const claims: { command: string; script: string }[] = [];
  const re = /`(npm run|pnpm run|pnpm|yarn run|yarn|bun run)\s+([a-zA-Z][\w:.-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    claims.push({ command: `${match[1]} ${match[2]}`, script: match[2]! });
  }
  return claims;
}

/**
 * Project-relative paths the content points at: `@`-references and backticked
 * paths that carry a directory separator, which is what distinguishes a file
 * reference from prose in backticks.
 */
function claimedPaths(content: string): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(/(?:^|\s)@([\w./-]+\/[\w./-]+)/gm)) paths.add(match[1]!);
  for (const match of content.matchAll(/`([\w.-]+(?:\/[\w.*-]+)+)`/g)) paths.add(match[1]!);
  return [...paths];
}

/** True for a reference no filesystem check can settle (globs, placeholders). */
const isConcretePath = (file: string): boolean =>
  !file.includes('*') && !file.includes('<') && /\.[a-zA-Z0-9]+$/.test(file);

/**
 * Every file in the project, project-relative, for resolving references the
 * way a reader would. Bounded and ignore-aware: this runs per kind, and a
 * `node_modules` walk would cost more than the AI call it guards.
 */
function projectFiles(root: string): Set<string> {
  const found = new Set<string>();
  const ignore = createIgnore(root);
  const walk = (dir: string, depth: number): void => {
    if (depth > 5 || found.size > 20_000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
      if (ignore.ignores(rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
      else found.add(rel);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * Whether a claimed path is one this project can be said to be missing.
 *
 * Documentation addresses files the way people talk about them, and most of
 * what looks like a broken reference is not one: `./core/colorflag.js` is an
 * import specifier quoted from source, `scan/analyzer.ts` is shorthand for
 * `src/scan/analyzer.ts` inside a paragraph that already said `src/`, and
 * `keys/index.json` lives under the user's home, not the repo. Only a path
 * that addresses this project's own tree and resolves nowhere in it counts.
 */
function isMissingReference(claimed: string, root: string, files: Set<string>): boolean {
  // Import specifiers are quoted code, not filesystem claims.
  if (claimed.startsWith('./') || claimed.startsWith('../')) return false;
  if (files.has(claimed) || fs.existsSync(path.join(root, claimed))) return false;
  // Shorthand: `scan/analyzer.ts` for `src/scan/analyzer.ts`.
  if ([...files].some((f) => f.endsWith(`/${claimed}`))) return false;
  // A first segment that is not a real top-level entry is addressing
  // something else entirely — another repo, a home directory, an example.
  const head = claimed.split('/')[0]!;
  return fs.existsSync(path.join(root, head));
}

/**
 * A verb that proposes a file into existence, directly governing the path
 * that follows it — "add a `…`", "create the `…`". Deliberately excludes
 * vague modals ("should", "would") and refuses distance: a sentence that
 * merely contains "adding" somewhere is not proposing the file it later
 * points at.
 */
const PROPOSES =
  /\b(adopt|adds?|adding|creat(e|ing)|introduc(e|ing)|recommend|consider|missing|todo)\b[^.,;:]{0,30}?[(`"']?$/;

/**
 * True when every mention of the file proposes it rather than points at it.
 * The artifact prompts require unmet standards to be written as adoption
 * steps, so "Add `.github/dependabot.yml`" is the format working, not a
 * broken reference — but one plain reference anywhere makes it a real claim.
 */
function isProposal(content: string, claimed: string): boolean {
  let seen = false;
  let index = content.indexOf(claimed);
  while (index !== -1) {
    seen = true;
    const before = content.slice(Math.max(0, index - 80), index).toLowerCase();
    // Stay within the sentence/table cell the reference sits in.
    if (!PROPOSES.test(before.split('\n').pop() ?? '')) return false;
    index = content.indexOf(claimed, index + claimed.length);
  }
  return seen;
}

function validateFrontmatter(kind: ArtifactKind, file: ArtifactFile): ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];
  const needsFrontmatter = ['agents', 'skills', 'commands'].includes(kind.id);
  if (!needsFrontmatter || !file.file.endsWith('.md')) return issues;

  const fields = frontmatter(file.content);
  if (!fields) {
    return [{ file: file.file, message: 'missing YAML frontmatter', severity: 'error' }];
  }
  if (kind.id === 'commands') {
    if (!fields['description'])
      issues.push({
        file: file.file,
        message: 'frontmatter has no description',
        severity: 'error',
      });
    // A command that reads $ARGUMENTS should tell the user what to type.
    if (file.content.includes('$ARGUMENTS') && !fields['argument-hint'])
      issues.push({
        file: file.file,
        message: 'uses $ARGUMENTS without an argument-hint',
        severity: 'warning',
      });
    return issues;
  }
  for (const required of ['name', 'description']) {
    if (!fields[required])
      issues.push({
        file: file.file,
        message: `frontmatter has no ${required}`,
        severity: 'error',
      });
  }
  if (kind.id !== 'agents') return issues;

  const model = fields['model'];
  if (!model) {
    issues.push({ file: file.file, message: 'frontmatter has no model', severity: 'error' });
  } else if (!KNOWN_MODELS.has(model)) {
    issues.push({
      file: file.file,
      message: `model "${model}" is not one of ${[...KNOWN_MODELS].join(', ')}`,
      severity: 'error',
    });
  }
  const tools = fields['tools'];
  if (!tools) {
    issues.push({ file: file.file, message: 'frontmatter has no tools list', severity: 'error' });
  } else {
    const named = tools
      .split(/[\s,]+/)
      .map((t) => t.replace(/^-/, '').trim())
      .filter(Boolean);
    for (const tool of named) {
      if (!KNOWN_TOOLS.has(tool))
        issues.push({
          file: file.file,
          message: `tools lists "${tool}", which is not a Claude Code tool`,
          severity: 'error',
        });
    }
  }
  return issues;
}

/**
 * Every claim in `files` that the project contradicts. `root` is the target
 * project; `planned` are the paths this run is about to write, which count as
 * existing even though they are not on disk yet.
 */
export function validateArtifacts(
  kind: ArtifactKind,
  artifacts: ArtifactFile[],
  analysis: ProjectAnalysis,
  root: string,
  planned: string[] = [],
): ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];
  const scripts = new Set(Object.keys(analysis.scripts));
  const plannedSet = new Set([...planned, ...artifacts.map((f) => f.file)]);
  // Built on first use: a kind whose content names no paths never walks.
  let files: Set<string> | undefined;

  for (const file of artifacts) {
    issues.push(...validateFrontmatter(kind, file));

    // Only meaningful when the project declares scripts at all: a project with
    // none has nothing to contradict, and the reference may be an adoption step.
    if (scripts.size > 0) {
      const seen = new Set<string>();
      for (const { command, script } of claimedScripts(file.content)) {
        if (scripts.has(script) || seen.has(script)) continue;
        seen.add(script);
        issues.push({
          file: file.file,
          message: `references \`${command}\`, but this project has no "${script}" script`,
          severity: 'error',
        });
      }
    }

    for (const claimed of claimedPaths(file.content)) {
      if (!isConcretePath(claimed) || isKitPath(claimed) || plannedSet.has(claimed)) continue;
      if (!isMissingReference(claimed, root, files ?? (files = projectFiles(root)))) continue;
      if (isProposal(file.content, claimed)) continue;
      issues.push({
        file: file.file,
        message: `references \`${claimed}\`, which does not exist in this project`,
        severity: 'warning',
      });
    }
  }
  return issues;
}

/** One line per issue, for the run report. */
export const formatIssue = (issue: ArtifactIssue): string => `${issue.file}: ${issue.message}`;
