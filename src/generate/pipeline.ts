import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { analyzeProject, ProjectAnalysis, renderContextMarkdown } from '../scan/analyzer.js';
import {
  availableProviders,
  modelFor,
  pricingFor,
  PROVIDERS,
  ProviderSpec,
  route,
} from '../providers/router.js';
import { openVault } from '../core/vault.js';
import { writeFileAtomic } from '../core/fsx.js';
import { generateRules } from '../rules/generators.js';
import { detectedAiTools } from '../plugins/tools.js';
import { log } from '../core/logger.js';
import { startSpinner } from '../core/spinner.js';
import {
  buildDigest,
  digestBudgetFor,
  parseFileRequests,
  REQUEST_SPEC,
  serveFileRequests,
} from './digest.js';
import {
  ARTIFACT_KINDS,
  ArtifactFile,
  ArtifactKind,
  isAllowedPath,
  kindsById,
  DEFAULT_RIGOR,
  type Rigor,
  parseFileBlocks,
} from './artifacts.js';
import { fingerprintOf, readManifest, signatureOf, writeManifest } from './manifest.js';
import { ArtifactIssue, formatIssue, validateArtifacts } from './validate.js';
import { readCachedReview, writeCachedReview } from './cache.js';
import { VERSION } from '../core/pkg.js';

/**
 * Generation pipeline (Phase 5): review the codebase first (analysis +
 * digest), then produce everything in one pass — the scaffold and context
 * files, and each artifact kind (rules, agents, skills, commands, prompts,
 * docs) tailored by an AI provider when one is configured. Every returned
 * path is validated before writing. Falls back to static generation per kind
 * when no provider is available or a call fails — `meridian generate` always
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
  /**
   * Files that may be overwritten even without --force: `meridian sync`
   * passes the generated files the user has not edited (manifest hash still
   * matches), so a refresh never clobbers hand-tuned content.
   */
  refresh?: string[];
  /** Artifact kinds generated at once; defaults to the provider's own limit. */
  concurrency?: number;
  /** Ignore (and refresh) the cached codebase review for this digest. */
  noCache?: boolean;
  /**
   * Rule-mirror tool ids (`claude`, `cursor`, `codex`, `copilot`, `gemini`).
   * Empty/undefined = the tools detected for this project, falling back to
   * every target when none is detected — a container or CI box has no editors
   * installed and must still produce a complete kit.
   */
  tools?: string[];
  /**
   * How much process the generated working agreement imposes. Defaults to
   * `standard`; `meridian sync` reads the level back off the manifest so a
   * refresh never quietly re-rigs a kit the user generated as `light`.
   */
  rigor?: Rigor;
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
  /** True when the codebase review was served from cache instead of the AI. */
  reviewFromCache?: boolean;
  /**
   * Files the review pass asked to read beyond the digest — what the AI
   * decided it needed to see, which is worth reporting.
   */
  requestedFiles?: string[];
  /**
   * Claims in the generated content that the project contradicts — an invented
   * script, a dead path reference, a malformed agent header. Survivors of the
   * retry in `generateKind`, so the run reports what it kept.
   */
  issues: ArtifactIssue[];
}

/**
 * Run `task` over `items` with at most `limit` in flight, preserving input
 * order in the results. Artifact kinds are independent — one HTTP call each —
 * so a run that took the sum of every kind's latency now takes roughly the
 * slowest few.
 */
async function inPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await task(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Artifact kinds grouped into dependency waves: every kind in a wave can run
 * concurrently, and a wave only starts once the kinds it depends on have
 * produced their files. Only kinds selected for this run count as
 * dependencies — `meridian generate commands` must not stall waiting for a
 * skills pass that is not happening; it reads what is on disk instead.
 */
export function dependencyWaves(kinds: ArtifactKind[]): ArtifactKind[][] {
  const selected = new Set(kinds.map((k) => k.id));
  const waves: ArtifactKind[][] = [];
  const satisfied = new Set<string>();
  let remaining = kinds;
  while (remaining.length > 0) {
    const ready = remaining.filter((k) =>
      (k.dependsOn ?? []).every((dep) => !selected.has(dep) || satisfied.has(dep)),
    );
    // A dependency cycle would otherwise loop forever: run what is left as one
    // wave rather than hanging the command.
    const wave = ready.length > 0 ? ready : remaining;
    waves.push(wave);
    for (const kind of wave) satisfied.add(kind.id);
    const inWave = new Set(wave);
    remaining = remaining.filter((k) => !inWave.has(k));
  }
  return waves;
}

/**
 * Markdown a dependency kind has already written under `prefixes`. Bounded:
 * this reads the kit's own directories, which are small and shallow by
 * construction. A prefix that names an exact file (`.meridian/rules.md`) is
 * read directly — a kind can depend on a single-file kind.
 */
function readKitFiles(root: string, prefixes: string[]): ArtifactFile[] {
  const files: ArtifactFile[] = [];
  const readOne = (rel: string): void => {
    try {
      files.push({ file: rel, content: fs.readFileSync(path.join(root, rel), 'utf8') });
    } catch {
      // Not generated yet — the dependent kind simply works without it.
    }
  };
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || files.length >= 100) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      try {
        files.push({
          file: path.relative(root, full).split(path.sep).join('/'),
          content: fs.readFileSync(full, 'utf8'),
        });
      } catch {
        // An unreadable kit file simply contributes no context.
      }
    }
  };
  for (const prefix of prefixes) {
    if (prefix.endsWith('/')) walk(path.join(root, prefix), 0);
    else readOne(prefix);
  }
  return files;
}

/**
 * What a dependent kind's prompt gets to see. Files this run generated win;
 * for a dependency outside this run, the kit already on disk stands in, so a
 * partial run still builds on the real thing instead of guessing.
 */
function upstreamFor(
  kind: ArtifactKind,
  root: string,
  produced: Map<string, ArtifactFile[]>,
): ArtifactFile[] {
  return (kind.dependsOn ?? []).flatMap((id) => {
    const generated = produced.get(id);
    if (generated) return generated;
    const dep = ARTIFACT_KINDS.find((k) => k.id === id);
    return dep ? readKitFiles(root, dep.allowedPaths) : [];
  });
}

/** Errors that will keep failing for the rest of the run (limits, quota). */
function isQuotaError(message: string): boolean {
  return /usage limit|limit reached|rate.?limit|quota|429|exhaust/i.test(message);
}

function pcDimFiles(files: ArtifactFile[]): string {
  const names = files.map((f) => f.file.split('/').pop()).slice(0, 3);
  return pc.dim(`(${names.join(', ')}${files.length > 3 ? ', …' : ''})`);
}

/** Fallback when a provider states no limit of its own. */
const DEFAULT_CONCURRENCY = 3;

/**
 * How many artifact kinds to generate at once. A provider knows best what it
 * can take — a local Ollama serving one model is slower in parallel, a
 * subscription CLI spawns a process per call — so its own limit wins unless
 * the user passes `--concurrency`. Static generation is CPU-only: no pool.
 */
export function concurrencyFor(
  provider: ProviderSpec | null,
  override: number | undefined,
  kindCount: number,
): number {
  if (!provider) return 1;
  // A malformed override must never silently produce a pool of zero workers.
  const limit =
    override !== undefined && Number.isInteger(override) && override > 0
      ? override
      : (provider.parallel ?? DEFAULT_CONCURRENCY);
  return Math.max(1, Math.min(limit, kindCount));
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

const REVIEW_PROMPT = `You are Meridian, a tool that makes codebases AI-assistant-ready.
Read the project digest below thoroughly — every file excerpt, the layout,
the dependencies and scripts — and write a deep codebase review in markdown:

## What this project is — purpose and domain, in the project's own terms
## Architecture — each real directory/module, its responsibility, and how
   control/data flows between them (cite actual files)
## Core concepts — the domain model, from the digest's Code map: the key
   classes, functions, interfaces and types, what each represents, and how
   they relate. Cover every load-bearing symbol — a concept missing here
   will be missing from every generated file.
## Conventions & idioms — naming, error handling, typing, patterns you can
   SEE in the source excerpts, with a file reference for each
## Testing & verification — frameworks, where tests live, the exact commands
## Gotchas — platform quirks, generated files, ordering constraints, anything
   an AI assistant could get wrong here
## Maturity & gaps — measure the project against the professional/enterprise
   bar for its stack: testing depth, CI, security posture, error handling,
   release discipline, documentation. Name only gaps the digest actually
   shows (or conspicuously lacks) — no speculation.
## Trajectory — where this project is headed, from the evidence: README
   goals, CHANGELOG history, roadmap/TODO files, half-built modules,
   dependency choices. State what the codebase is growing toward so the
   generated kit prepares it for that future, not just its present.

Be concrete and cite real paths. This review will be the foundation for
generating the project's AI configuration files — the maturity gaps and
trajectory you identify here must shape the standards those files set.
Output markdown only.

--- PROJECT DIGEST ---
`;

/**
 * The digest is a budget spent by heuristic, so it can miss the one file that
 * settles a question. Before writing, the reviewer may ask for what it is
 * missing — grounded on real source beats a confident guess, and a guess in
 * the review propagates into every artifact generated from it.
 */
const REQUEST_OFFER = `
Before you write the review you may ask to read files the digest does not
contain — the Code map lists files whose contents were not excerpted, and the
Recent activity section names the files under active development. If reading
one would change what you write, ask for it instead of guessing.

To ask, respond with ONLY this block and nothing else:

${REQUEST_SPEC}

Ask for at most 12 paths, exactly as they appear in the digest, and only for
files that would genuinely change the review — the load-bearing modules, the
ones the history shows are changing, the tests that pin real behavior. You may
ask twice; after that, write the review from what you have. If you have enough
already, do not ask at all — just write the review.
`;

/** Appended once the reviewer has used up its rounds. */
const NO_MORE_REQUESTS = `
You have already received the files you asked for. Do not request more —
write the full review now, from everything above.
`;

/** Request rounds allowed, so a reading pass can never loop up a bill. */
const MAX_REVIEW_ROUNDS = 2;
/** Chars of requested source served per round. */
const REQUEST_BUDGET_CHARS = 40_000;

/** A leading/trailing markdown fence some providers wrap whole answers in. */
function unfence(text: string): string {
  const fenced = /^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/.exec(text.trim());
  return (fenced ? fenced[1]! : text).trim();
}

/**
 * The reading pass: the provider studies the project, asks for anything the
 * digest left out, and writes the review that grounds every artifact kind.
 * Returns the review plus the extra source it was written from, so the kinds
 * see exactly the evidence the review was based on.
 */
async function readCodebase(
  provider: ProviderSpec,
  apiKey: string,
  root: string,
  digestText: string,
  onRequest: (paths: string[], refused: number) => void,
): Promise<{ review: string; extra: string; requested: string[] }> {
  let extra = '';
  const requested: string[] = [];
  for (let round = 0; ; round++) {
    const last = round >= MAX_REVIEW_ROUNDS;
    const prompt =
      REVIEW_PROMPT.replace(
        '--- PROJECT DIGEST ---',
        `${last ? NO_MORE_REQUESTS : REQUEST_OFFER}\n--- PROJECT DIGEST ---`,
      ) +
      digestText +
      extra;
    const response = await provider.ask(prompt, apiKey);
    // A request is the whole answer or it is not a request. The review is
    // specified as a sequence of `##` sections, so a response carrying them is
    // a review that quoted the protocol — which is exactly what happens when a
    // project whose own source describes this protocol gets a kit generated.
    const quoted = /^#{1,3} \S/m.test(response);
    const asks = last || quoted ? [] : parseFileRequests(response);
    if (asks.length === 0) {
      // A final answer that still carries a request block would otherwise put
      // the protocol itself into the review file.
      return {
        review: unfence(response.replace(/<<<REQUEST>>>[\s\S]*?<<<END>>>/g, '').trim()),
        extra,
        requested,
      };
    }
    const served = serveFileRequests(root, asks, REQUEST_BUDGET_CHARS);
    onRequest(served.served, served.refused.length);
    extra += served.text;
    requested.push(...served.served);
  }
}

/**
 * What to tell a provider so its second attempt fixes the first.
 *
 * The retry used to re-send the identical prompt and hope for a better roll,
 * even though the validator knew precisely what was wrong — an invented
 * script, a dead path, a missing file. Saying so turns the retry into a
 * repair: the model is told what was rejected and why, in the project's own
 * terms, and what it must not do again.
 */
export function correctionFor(
  kind: ArtifactKind,
  previous: ArtifactFile[],
  issues: ArtifactIssue[],
): string {
  const problems: string[] = [];
  if (previous.length === 0) {
    problems.push(
      'You returned no file blocks at all. Every file must be wrapped in the ' +
        '<<<FILE path>>> … <<<END>>> markers exactly as specified above.',
    );
  } else {
    const names = new Set(previous.map((f) => f.file));
    const missing = (kind.requiredFiles ?? []).filter((f) => !names.has(f));
    if (missing.length) problems.push(`These required files were missing: ${missing.join(', ')}.`);
    if (previous.length < (kind.minFiles ?? 1))
      problems.push(
        `You returned ${previous.length} file${previous.length === 1 ? '' : 's'}; ` +
          `this kind needs at least ${kind.minFiles}.`,
      );
    for (const issue of issues.filter((i) => i.severity === 'error'))
      problems.push(`${issue.file}: ${issue.message}.`);
    for (const issue of issues.filter((i) => i.severity === 'warning'))
      problems.push(`${issue.file}: ${issue.message} (fix or remove the reference).`);
  }
  if (problems.length === 0) return '';

  return `

--- YOUR PREVIOUS ATTEMPT WAS REJECTED ---
You already answered this request. The answer was checked against the real
project and rejected for the reasons below. Every one of them is a fact about
this project, not an opinion — do not argue with them, correct them.

${problems.map((p) => `- ${p}`).join('\n')}

Now produce the COMPLETE set of files again — not a patch, not a diff, not an
explanation. Keep everything that was right; change only what is listed above.

While you rewrite:
- Every script, path, command and dependency you name must appear in the
  project digest. If you cannot point to it there, delete the sentence rather
  than rephrase it — a claim this project contradicts is worse than saying
  nothing, because the next assistant reads it as authority.
- A practice this project has not adopted yet may only appear as an explicit
  adoption step ("Adopt X", "Add X"), never as something it already does.
- Respond with file blocks and nothing else. Do not acknowledge this message.`;
}

/**
 * Which tools' instruction files this run mirrors the rules into.
 *
 * An explicit `--tools` list wins. Otherwise the project's detected tools,
 * and if nothing is detected, every target — a kit that silently shipped no
 * instruction file at all would be worse than one with a spare.
 */
export function mirrorTools(opts: Pick<GenerateOptions, 'root' | 'tools'>): string[] | undefined {
  if (opts.tools?.length) return opts.tools.includes('all') ? undefined : opts.tools;
  const detected = detectedAiTools(opts.root);
  return detected.length ? detected : undefined;
}

async function generateKind(
  kind: ArtifactKind,
  digest: string,
  provider: ProviderSpec | null,
  apiKey: string,
  analysis: ProjectAnalysis,
  root: string,
  planned: string[],
  upstream: ArtifactFile[],
  rigor: Rigor,
): Promise<{
  files: ArtifactFile[];
  source: 'ai' | 'static';
  error?: string;
  issues?: ArtifactIssue[];
}> {
  // A kind's invariants hold for every source: what a provider returned is
  // finalized exactly like the static template it replaced.
  const finalize = (files: ArtifactFile[]): ArtifactFile[] =>
    kind.finalize ? kind.finalize(files, analysis, rigor) : files;

  if (!provider) return { files: finalize(kind.fallback(analysis)), source: 'static' };

  // A well-formed response meets the kind's own bar, not just "some blocks".
  const isComplete = (files: ArtifactFile[]): boolean => {
    if (files.length < (kind.minFiles ?? 1)) return false;
    const names = new Set(files.map((f) => f.file));
    return (kind.requiredFiles ?? []).every((f) => names.has(f));
  };

  // AI mode never silently writes static templates: a failed kind writes
  // nothing, so a later re-run regenerates it with AI. One retry covers a
  // response that forgets the file-block protocol, comes back incomplete, or
  // makes a claim the project contradicts — an invented script or a malformed
  // agent header is worse than a missing file, because it reads as authority.
  // A second answer with the same faults is kept: the issues are reported, and
  // a re-run fills in what is missing since existing files are skipped.
  let lastIssues: ArtifactIssue[] = [];
  let lastFiles: ArtifactFile[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // The second attempt is a repair, not a re-roll: it carries what the
      // first attempt got wrong, so the model fixes it instead of guessing
      // again from the same prompt.
      const correction = attempt === 0 ? '' : correctionFor(kind, lastFiles, lastIssues);
      const response = await provider.ask(kind.prompt(digest, upstream) + correction, apiKey);
      const files = parseFileBlocks(response);
      const issues = files.length
        ? validateArtifacts(kind, files, analysis, root, planned)
        : lastIssues;
      const blocking = issues.filter((i) => i.severity === 'error');
      if (files.length > 0 && ((isComplete(files) && blocking.length === 0) || attempt > 0)) {
        if (!isComplete(files))
          log.warn(`${kind.name}: response incomplete after a retry — keeping what was returned.`);
        for (const issue of blocking)
          log.warn(`${kind.name}: ${formatIssue(issue)} — kept after a retry.`);
        return { files: finalize(files), source: 'ai', issues };
      }
      lastIssues = issues;
      lastFiles = files;
      const reason =
        files.length === 0
          ? 'no file blocks'
          : blocking.length > 0
            ? `content the project contradicts (${formatIssue(blocking[0]!)})`
            : 'an incomplete set of files';
      log.warn(`${kind.name}: provider returned ${reason}${attempt ? '' : ' — retrying'}.`);
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
        file: '.meridian/project.json',
        content:
          JSON.stringify(
            { name: analysis.name, meridian: 1, createdWith: 'meridian generate' },
            null,
            2,
          ) + '\n',
      },
      { file: '.meridian/context.md', content: renderContextMarkdown(analysis) },
      {
        file: 'README_AI.md',
        content: `# ${analysis.name} — AI Assistant Guide

This project is managed with [Meridian](https://meridian.sh). Everything below
is generated by \`meridian generate\` — run \`meridian sync\` after significant
changes to refresh what is stale (hand-edited files are preserved).

| File | Purpose |
| --- | --- |
| \`.meridian/context.md\` | Generated project context |
| \`.meridian/rules.md\` | Canonical rules — source for all instruction files |
| \`CLAUDE.md\` / \`AGENTS.md\` / \`GEMINI.md\` | Tool-specific instructions |
| \`docs/\` | Professional docs suite (architecture, conventions, workflow, …) |
| \`.claude/agents/\` | Project-tailored subagents |
| \`.claude/skills/\` | Project workflows — the one home for multi-step procedures |
| \`.claude/commands/\` | Slash commands: one per skill, plus one-shot session actions |
| \`.claude/settings.json\` | Claude Code harness config (permissions, hooks) |
| \`.meridian/prompts/\` | Reusable prompts |
| \`.meridian/docs/\` | AI working notes (codebase review) |
| \`.meridian/manifest.json\` | Kit manifest — powers \`meridian sync\` |
`,
      },
    ],
    // These mirror the code and are refreshed on every run.
    derived: ['.meridian/context.md'],
  };
}

export interface GenerateEstimate {
  provider: string | null;
  model: string | null;
  /** One review pass plus one call per kind (retries excluded). */
  calls: number;
  kinds: string[];
  digestChars: number;
  inputTokens: number;
  /** Assumed, not measured — see ASSUMED_OUTPUT_TOKENS. */
  outputTokens: number;
  usdLow: number | null;
  usdHigh: number | null;
  /** Where the price came from, so a wrong number is traceable. */
  priceSource: 'config' | 'builtin' | null;
  /** Set when the provider bills by subscription or runs locally. */
  billedAs?: string;
}

/**
 * Output size cannot be known before the call, so the estimate assumes a
 * full-but-not-maximal response per artifact kind and a shorter review. These
 * are the numbers the range in the printed estimate is built from.
 */
const ASSUMED_OUTPUT_TOKENS = { review: 3_000, kind: 5_000 };
/** Rough chars-per-token, adequate for a pre-run order-of-magnitude figure. */
const CHARS_PER_TOKEN = 4;
/**
 * Chars a dependent kind carries from each kind it builds on. The real figure
 * is whatever that kind wrote, which cannot be known before the run — this is
 * a mid-sized rules or skill file, and it is counted so the estimate does not
 * quietly omit a cost the run will pay.
 */
const ASSUMED_UPSTREAM_CHARS = 12_000;

/**
 * What a `meridian generate` run would cost, without making a single AI call.
 * The digest is built for real — it is the actual input — so the token count
 * reflects this project rather than an average one.
 */
export function estimateGenerate(opts: GenerateOptions): GenerateEstimate {
  const kinds = kindsById(opts.kinds);
  const provider = opts.noAi ? null : pickProvider(opts.provider);
  const digest = buildDigest(
    opts.root,
    undefined,
    provider ? digestBudgetFor(provider.contextTokens) : undefined,
  );

  const reviewInput = (REVIEW_PROMPT.length + digest.text.length) / CHARS_PER_TOKEN;
  // Every kind prompt carries the digest *and* the review it grounds on.
  const groundedDigest = digest.text.length + ASSUMED_OUTPUT_TOKENS.review * CHARS_PER_TOKEN;
  const kindInput = kinds.reduce((sum, kind) => {
    // A dependency read back from disk costs the same as one this run wrote,
    // so every declared dependency counts whether or not it is in this run.
    const upstream = (kind.dependsOn ?? []).length * ASSUMED_UPSTREAM_CHARS;
    return sum + (kind.prompt('').length + groundedDigest + upstream) / CHARS_PER_TOKEN;
  }, 0);
  const inputTokens = Math.round(reviewInput + kindInput);
  const outputTokens = ASSUMED_OUTPUT_TOKENS.review + ASSUMED_OUTPUT_TOKENS.kind * kinds.length;

  const model = provider ? modelFor(provider) : null;
  const priced = model ? pricingFor(model) : null;
  const usd = priced
    ? (inputTokens * priced.price.inputPerMTok + outputTokens * priced.price.outputPerMTok) / 1e6
    : null;

  return {
    provider: provider?.id ?? null,
    model,
    calls: provider ? kinds.length + 1 : 0,
    kinds: kinds.map((k) => k.id),
    digestChars: digest.text.length,
    inputTokens,
    outputTokens,
    // Output is the uncertain half: report a band, not false precision.
    usdLow: usd === null ? null : Number((usd * 0.6).toFixed(2)),
    usdHigh: usd === null ? null : Number((usd * 1.5).toFixed(2)),
    priceSource: priced?.source ?? null,
    billedAs: !provider
      ? undefined
      : provider.needsKey
        ? undefined
        : provider.id === 'ollama'
          ? 'free — runs locally'
          : 'included in your subscription (no per-token charge)',
  };
}

export async function runGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const rigor = opts.rigor ?? DEFAULT_RIGOR;
  const kinds = kindsById(opts.kinds);
  // Which tools to mirror into is decided before this run writes anything.
  // The artifact kinds create .claude/ for agents, skills and commands, and
  // detection counts that directory as evidence of Claude Code — so deciding
  // later would read this run's own output back as "a Claude-only project"
  // and silently skip the other four instruction files.
  //
  // Detection shells out once per tool, so it is skipped for a run that will
  // not mirror anything: the same condition the propagation step below uses.
  const willMirror = !opts.dryRun && kinds.some((k) => k.id === 'rules');
  const mirrors = willMirror ? mirrorTools(opts) : undefined;
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
    issues: [],
  };

  // Content signature of everything this run writes, recorded in the kit
  // manifest so `meridian sync` can later tell user-edited files from
  // untouched ones — through the project's own formatter, which rewrites the
  // kit's markdown without changing what it says.
  const writtenSignatures = new Map<string, string>();
  const refreshable = new Set(opts.refresh ?? []);

  // Writes happen as each kind finishes, but the returned records are
  // collected per kind so a parallel run still reports in kind order.
  const write = (
    kindId: string,
    files: ArtifactFile[],
    source: 'ai' | 'static',
    allowed: string[] | null,
    derived: string[],
  ): FileResult[] => {
    const records: FileResult[] = [];
    for (const f of files) {
      if (allowed && !isAllowedPath(f.file, allowed)) {
        records.push({ kind: kindId, file: f.file, action: 'rejected-path', source });
        continue;
      }
      const target = path.join(opts.root, f.file);
      const refresh = derived.includes(f.file) || refreshable.has(f.file);
      if (fs.existsSync(target) && !opts.force && !refresh) {
        records.push({ kind: kindId, file: f.file, action: 'skipped-exists', source });
        continue;
      }
      if (opts.dryRun) {
        records.push({ kind: kindId, file: f.file, action: 'planned', source });
        continue;
      }
      writeFileAtomic(target, f.content);
      writtenSignatures.set(f.file, signatureOf(f.content));
      records.push({ kind: kindId, file: f.file, action: 'written', source });
    }
    return records;
  };

  // The codebase review itself produces the scaffold + context files.
  const scaffold = scaffoldFiles(analysis);
  result.files.push(...write('scan', scaffold.files, 'static', null, scaffold.derived));

  // AI reading pass: the provider studies the codebase once and writes a
  // review that grounds every artifact it generates afterwards.
  let context = digest.text;
  if (provider && !opts.dryRun) {
    const cacheKey = {
      root: opts.root,
      provider: provider.id,
      model: modelFor(provider),
      digest: digest.text,
    };
    const cached = opts.noCache ? null : readCachedReview(cacheKey);
    const spin = startSpinner(
      cached
        ? 'Reusing the cached codebase review…'
        : `${provider.name} is reading the codebase (${Math.max(1, Math.round(digest.text.length / 1000))}k chars)…`,
    );
    try {
      // A cache hit re-serves the files the cached review asked for: the review
      // was written knowing them, so the kinds that build on it must see them
      // too. Reading them back costs a few file reads, not an AI call.
      const pass = cached
        ? {
            review: cached.review,
            extra: serveFileRequests(opts.root, cached.requested, REQUEST_BUDGET_CHARS).text,
            requested: cached.requested,
          }
        : await readCodebase(provider, apiKey, opts.root, digest.text, (served, refused) => {
            const asked = served.length + refused;
            spin.update(
              `${provider.name} asked to read ${asked} more file${asked === 1 ? '' : 's'}` +
                `${served.length ? ` — ${served.slice(0, 3).join(', ')}${served.length > 3 ? ', …' : ''}` : ''}…`,
            );
          });
      const review = pass.review;
      if (review) {
        if (!cached) writeCachedReview(cacheKey, { review, requested: pass.requested });
        result.reviewFromCache = Boolean(cached);
        result.requestedFiles = pass.requested;
        context = `${digest.text}${pass.extra}\n\n--- YOUR CODEBASE REVIEW (you wrote this after reading the project) ---\n${review}`;
        result.files.push(
          ...write(
            'scan',
            [{ file: '.meridian/docs/codebase-review.md', content: review + '\n' }],
            'ai',
            null,
            ['.meridian/docs/codebase-review.md'],
          ),
        );
      }
      const asked = pass.requested.length
        ? ` (asked for ${pass.requested.length} more file${pass.requested.length === 1 ? '' : 's'})`
        : '';
      spin.succeed(
        cached
          ? `Codebase unchanged since the last review — reused it (no AI call)${asked}`
          : `AI read the codebase${asked} → .meridian/docs/codebase-review.md`,
      );
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

  // Kinds are independent calls, so they run concurrently up to the limit the
  // provider can take. A usage limit hit by any one of them stops the rest:
  // every remaining call would fail the same way and burn the same wait.
  const concurrency = concurrencyFor(provider, opts.concurrency, kinds.length);
  const progress =
    provider && kinds.length > 1
      ? startSpinner(
          `Generating ${kinds.length} artifact kinds${concurrency > 1 ? ` (${concurrency} at a time)` : ''}…`,
        )
      : null;
  let completed = 0;

  interface KindOutcome {
    kind: ArtifactKind;
    files: FileResult[];
    issues: ArtifactIssue[];
    error?: string;
    generated: number;
    names: string;
  }

  // Files this run will write across every kind: a reference to one of them is
  // valid even though it is not on disk while the kind that cites it runs.
  const plannedPaths = kinds.flatMap((k) => k.requiredFiles ?? []);

  // What each kind produced, so a kind that declares `dependsOn` can build on
  // it — `commands` delegates to the skills `skills` just wrote instead of
  // independently reinventing the same workflows.
  const produced = new Map<string, ArtifactFile[]>();

  const runKind = async (kind: ArtifactKind): Promise<KindOutcome> => {
    if (result.aborted)
      return { kind, files: [], issues: [], error: 'skipped', generated: 0, names: '' };
    const single =
      provider && !progress
        ? startSpinner(`Generating ${kind.name.toLowerCase()} — ${kind.description}…`)
        : null;
    const { files, source, error, issues } = await generateKind(
      kind,
      context,
      provider,
      apiKey,
      analysis,
      opts.root,
      plannedPaths,
      upstreamFor(kind, opts.root, produced),
      rigor,
    );
    progress?.update(
      `Generating ${kinds.length} artifact kinds — ${++completed}/${kinds.length} done…`,
    );
    if (error) {
      single?.fail(`${kind.name}: ${error}`);
      if (isQuotaError(error)) result.aborted = error;
      return { kind, files: [], issues: [], error, generated: 0, names: '' };
    }
    produced.set(kind.id, files);
    single?.succeed(
      `${kind.name}: ${files.length} file${files.length === 1 ? '' : 's'} ${pcDimFiles(files)}`,
    );
    return {
      kind,
      files: write(kind.id, files, source, kind.allowedPaths, kind.alwaysOverwrite ?? []),
      issues: issues ?? [],
      generated: files.length,
      names: pcDimFiles(files),
    };
  };

  // Independent kinds run concurrently; a kind that depends on another waits
  // for the wave that produces it. Results are reassembled in the requested
  // order so the run still reports kind by kind.
  const byKind = new Map<string, KindOutcome>();
  for (const wave of dependencyWaves(kinds)) {
    for (const outcome of await inPool(wave, concurrency, runKind))
      byKind.set(outcome.kind.id, outcome);
  }
  const outcomes = kinds.map((kind) => byKind.get(kind.id)!);
  progress?.succeed(
    `Generated ${outcomes.filter((o) => !o.error).length}/${kinds.length} artifact kinds`,
  );

  for (const [i, outcome] of outcomes.entries()) {
    const step = `[${i + 1}/${kinds.length}]`;
    if (outcome.error) {
      result.failed.push(outcome.kind.id);
      if (progress && outcome.error !== 'skipped')
        log.warn(`${step} ${outcome.kind.name}: ${outcome.error}`);
      continue;
    }
    if (progress) {
      log.dim(
        `${step} ${outcome.kind.name}: ${outcome.generated} file${outcome.generated === 1 ? '' : 's'} ${outcome.names}`,
      );
    }
    result.files.push(...outcome.files);
    result.issues.push(...outcome.issues);
  }

  // Fresh rules should reach every tool's instruction file.
  if (!opts.dryRun && result.files.some((f) => f.kind === 'rules' && f.action === 'written')) {
    result.propagated = generateRules(opts.root, analysis.name, mirrors).map((g) => g.file);
    for (const file of result.propagated) {
      try {
        writtenSignatures.set(
          file,
          signatureOf(fs.readFileSync(path.join(opts.root, file), 'utf8')),
        );
      } catch {
        // A tool file that could not be read back is simply not tracked.
      }
    }
  }

  // Record what this run wrote, so `meridian sync` can detect both codebase
  // drift and user edits later. The fingerprint is taken from a fresh
  // post-write analysis — the kit's own files (docs/, CLAUDE.md, …) change
  // the project, and recording the pre-write state would make a brand-new
  // kit read as already drifted. Prior entries survive for files this run
  // skipped; a run that wrote nothing leaves the manifest untouched.
  if (!opts.dryRun && writtenSignatures.size > 0) {
    const prior = readManifest(opts.root);
    writeManifest(opts.root, {
      meridian: VERSION,
      generatedAt: new Date().toISOString(),
      provider: result.provider,
      rigor,
      fingerprint: fingerprintOf(analyzeProject(opts.root)),
      files: { ...(prior?.files ?? {}), ...Object.fromEntries(writtenSignatures) },
    });
  }
  return result;
}
