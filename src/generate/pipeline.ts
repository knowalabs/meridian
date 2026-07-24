import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { ProjectAnalysis, renderContextMarkdown } from '../scan/analyzer.js';
import {
  availableProviders,
  modelFor,
  PROVIDERS,
  ProviderSpec,
  route,
} from '../providers/router.js';
import { openVault } from '../core/vault.js';
import { writeFileAtomic } from '../core/fsx.js';
import { generateRules } from '../rules/generators.js';
import { log } from '../core/logger.js';
import { startSpinner } from '../core/spinner.js';
import { buildDigest, digestBudgetFor } from './digest.js';
import {
  ArtifactFile,
  ArtifactKind,
  isAllowedPath,
  kindsById,
  parseFileBlocks,
} from './artifacts.js';

/**
 * Generation pipeline (Phase 5): review the codebase first (analysis +
 * digest), then produce everything in one pass — the scaffold and context
 * files, and each artifact kind (rules, agents, skills, commands, prompts,
 * docs) tailored by an AI provider when one is configured. Every returned
 * path is validated before writing. Falls back to static generation per kind
 * when no provider is available or a call fails — `devpilot generate` always
 * leaves a complete kit.
 */

export interface GenerateOptions {
  root: string;
  /** Artifact kind ids to generate; empty = all. */
  kinds: string[];
  provider?: string;
  /** Overwrite existing files. */
  force: boolean;
  /** Report what would be written without touching disk. */
  dryRun: boolean;
  /** Skip AI even if a provider is available. */
  noAi: boolean;
}

export interface FileResult {
  kind: string;
  file: string;
  action: 'written' | 'skipped-exists' | 'planned' | 'rejected-path';
  source: 'ai' | 'static';
}

export interface GenerateResult {
  provider: string | null;
  model: string | null;
  files: FileResult[];
  /** Tool instruction files propagated from the generated rules. */
  propagated: string[];
  /**
   * Kinds whose AI generation failed. Nothing is written for them — a later
   * re-run picks them up, since existing files are skipped by default.
   */
  failed: string[];
  /** Set when the run stopped early (e.g. usage limit); the provider's message. */
  aborted?: string;
}

/** Errors that will keep failing for the rest of the run (limits, quota). */
function isQuotaError(message: string): boolean {
  return /usage limit|limit reached|rate.?limit|quota|429|exhaust/i.test(message);
}

function pcDimFiles(files: ArtifactFile[]): string {
  const names = files.map((f) => f.file.split('/').pop()).slice(0, 3);
  return pc.dim(`(${names.join(', ')}${files.length > 3 ? ', …' : ''})`);
}

export function pickProvider(forced?: string): ProviderSpec | null {
  const available = availableProviders();
  if (forced) {
    const p = PROVIDERS.find((p) => p.id === forced);
    if (!p || !available.includes(p.id)) return null;
    return p;
  }
  return route('generate ai project artifacts', available)?.provider ?? null;
}

const REVIEW_PROMPT = `You are DevPilot, a tool that makes codebases AI-assistant-ready.
Read the project digest below thoroughly — every file excerpt, the layout,
the dependencies and scripts — and write a deep codebase review in markdown:

## What this project is — purpose and domain, in the project's own terms
## Architecture — each real directory/module, its responsibility, and how
   control/data flows between them (cite actual files)
## Conventions & idioms — naming, error handling, typing, patterns you can
   SEE in the source excerpts, with a file reference for each
## Testing & verification — frameworks, where tests live, the exact commands
## Gotchas — platform quirks, generated files, ordering constraints, anything
   an AI assistant could get wrong here

Be concrete and cite real paths. This review will be the foundation for
generating the project's AI configuration files. Output markdown only.

--- PROJECT DIGEST ---
`;

async function generateKind(
  kind: ArtifactKind,
  digest: string,
  provider: ProviderSpec | null,
  apiKey: string,
  analysis: ProjectAnalysis,
): Promise<{ files: ArtifactFile[]; source: 'ai' | 'static'; error?: string }> {
  if (!provider) return { files: kind.fallback(analysis), source: 'static' };

  // A well-formed response meets the kind's own bar, not just "some blocks".
  const isComplete = (files: ArtifactFile[]): boolean => {
    if (files.length < (kind.minFiles ?? 1)) return false;
    const names = new Set(files.map((f) => f.file));
    return (kind.requiredFiles ?? []).every((f) => names.has(f));
  };

  // AI mode never silently writes static templates: a failed kind writes
  // nothing, so a later re-run regenerates it with AI. One retry covers a
  // response that forgets the file-block protocol or comes back incomplete;
  // an incomplete second answer is kept — the re-run fills in what is missing,
  // since existing files are skipped by default.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await provider.ask(kind.prompt(digest), apiKey);
      const files = parseFileBlocks(response);
      if (files.length > 0 && (isComplete(files) || attempt > 0)) {
        if (!isComplete(files))
          log.warn(`${kind.name}: response incomplete after a retry — keeping what was returned.`);
        return { files, source: 'ai' };
      }
      log.warn(
        `${kind.name}: provider returned ${files.length === 0 ? 'no file blocks' : 'an incomplete set of files'}${attempt ? '' : ' — retrying'}.`,
      );
    } catch (err) {
      return { files: [], source: 'ai', error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { files: [], source: 'ai', error: 'provider returned no file blocks after a retry' };
}

/** Scaffold + context files produced by the codebase review itself. */
function scaffoldFiles(analysis: ProjectAnalysis): { files: ArtifactFile[]; derived: string[] } {
  return {
    files: [
      {
        file: '.devpilot/project.json',
        content:
          JSON.stringify(
            { name: analysis.name, devpilot: 1, createdWith: 'devpilot generate' },
            null,
            2,
          ) + '\n',
      },
      { file: '.devpilot/context.md', content: renderContextMarkdown(analysis) },
      {
        file: 'README_AI.md',
        content: `# ${analysis.name} — AI Assistant Guide

This project is managed with [DevPilot](https://devpilot.sh). Everything below
is generated by \`devpilot generate\` — re-run it after significant changes.

| File | Purpose |
| --- | --- |
| \`.devpilot/context.md\` | Generated project context |
| \`.devpilot/rules.md\` | Canonical rules — source for all instruction files |
| \`CLAUDE.md\` / \`AGENTS.md\` / \`GEMINI.md\` | Tool-specific instructions |
| \`docs/\` | Professional docs suite (architecture, conventions, workflow, …) |
| \`.claude/agents/\` | Project-tailored subagents |
| \`.claude/skills/\` | Project workflows as skills |
| \`.claude/commands/\` | Slash commands for everyday tasks |
| \`.devpilot/prompts/\` | Reusable prompts |
| \`.devpilot/docs/\` | AI working notes (codebase review) |
`,
      },
    ],
    // These mirror the code and are refreshed on every run.
    derived: ['.devpilot/context.md'],
  };
}

export async function runGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const kinds = kindsById(opts.kinds);
  // Pick the provider first: the digest budget scales with its context
  // window, so a large-context provider gets to see far more of the project.
  const provider = opts.noAi ? null : pickProvider(opts.provider);
  const scanSpin = startSpinner('Reviewing codebase…');
  const digest = buildDigest(
    opts.root,
    undefined,
    provider ? digestBudgetFor(provider.contextTokens) : undefined,
  );
  const analysis = digest.analysis;
  const read = digest.includedFiles;
  const shown = read.slice(0, 5).join(', ') + (read.length > 5 ? ` +${read.length - 5} more` : '');
  scanSpin.succeed(
    `Reviewed ${analysis.totalFiles} files ${read.length ? `— read ${shown}` : ''}`.trim(),
  );

  const apiKey = provider?.needsKey ? (openVault().get(provider.id) ?? '') : '';
  if (provider) {
    log.dim(`→ generating with ${provider.name} [${modelFor(provider)}]`);
  } else {
    log.dim('→ no AI provider available — generating from static templates');
  }

  const result: GenerateResult = {
    provider: provider?.id ?? null,
    model: provider ? modelFor(provider) : null,
    files: [],
    propagated: [],
    failed: [],
  };

  const write = (
    kindId: string,
    files: ArtifactFile[],
    source: 'ai' | 'static',
    allowed: string[] | null,
    derived: string[],
  ): void => {
    for (const f of files) {
      if (allowed && !isAllowedPath(f.file, allowed)) {
        result.files.push({ kind: kindId, file: f.file, action: 'rejected-path', source });
        continue;
      }
      const target = path.join(opts.root, f.file);
      const refresh = derived.includes(f.file);
      if (fs.existsSync(target) && !opts.force && !refresh) {
        result.files.push({ kind: kindId, file: f.file, action: 'skipped-exists', source });
        continue;
      }
      if (opts.dryRun) {
        result.files.push({ kind: kindId, file: f.file, action: 'planned', source });
        continue;
      }
      writeFileAtomic(target, f.content);
      result.files.push({ kind: kindId, file: f.file, action: 'written', source });
    }
  };

  // The codebase review itself produces the scaffold + context files.
  const scaffold = scaffoldFiles(analysis);
  write('scan', scaffold.files, 'static', null, scaffold.derived);

  // AI reading pass: the provider studies the codebase once and writes a
  // review that grounds every artifact it generates afterwards.
  let context = digest.text;
  if (provider && !opts.dryRun) {
    const spin = startSpinner(
      `${provider.name} is reading the codebase (${Math.max(1, Math.round(digest.text.length / 1000))}k chars)…`,
    );
    try {
      let review = (await provider.ask(REVIEW_PROMPT + digest.text, apiKey)).trim();
      const fenced = /^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/.exec(review);
      if (fenced) review = fenced[1]!.trim();
      if (review) {
        context = `${digest.text}\n\n--- YOUR CODEBASE REVIEW (you wrote this after reading the project) ---\n${review}`;
        write(
          'scan',
          [{ file: '.devpilot/docs/codebase-review.md', content: review + '\n' }],
          'ai',
          null,
          ['.devpilot/docs/codebase-review.md'],
        );
      }
      spin.succeed(`AI read the codebase → .devpilot/docs/codebase-review.md`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isQuotaError(message)) {
        // Every following call would fail the same way — stop now, cleanly.
        spin.fail(`Provider limit hit while reading the codebase`);
        result.aborted = message;
        result.failed = kinds.map((k) => k.id);
        return result;
      }
      spin.fail(`Codebase review pass failed (${message}) — generating from the raw digest`);
    }
  }

  for (const [i, kind] of kinds.entries()) {
    if (result.aborted) {
      result.failed.push(kind.id);
      continue;
    }
    const step = `[${i + 1}/${kinds.length}]`;
    const spin = provider
      ? startSpinner(`${step} Generating ${kind.name.toLowerCase()} — ${kind.description}…`)
      : null;
    const { files, source, error } = await generateKind(kind, context, provider, apiKey, analysis);
    if (error) {
      result.failed.push(kind.id);
      spin?.fail(`${step} ${kind.name}: ${error}`);
      if (isQuotaError(error)) result.aborted = error;
      continue;
    }
    spin?.succeed(
      `${step} ${kind.name}: ${files.length} file${files.length === 1 ? '' : 's'} ${pcDimFiles(files)}`,
    );
    write(kind.id, files, source, kind.allowedPaths, kind.alwaysOverwrite ?? []);

    // Fresh rules should reach every tool's instruction file.
    if (kind.id === 'rules' && !opts.dryRun) {
      const wroteRules = result.files.some((f) => f.kind === 'rules' && f.action === 'written');
      if (wroteRules) {
        result.propagated = generateRules(opts.root, analysis.name).map((g) => g.file);
      }
    }
  }
  return result;
}
