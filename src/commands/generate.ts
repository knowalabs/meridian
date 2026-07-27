import pc from 'picocolors';
import { ARTIFACT_KINDS } from '../generate/artifacts.js';
import { estimateGenerate, pickProvider, runGenerate } from '../generate/pipeline.js';
import {
  availableProviders,
  hasModelChoice,
  modelFor,
  modelsFor,
  PROVIDERS,
  saveModelChoice,
  setRuntimeModel,
} from '../providers/router.js';
import { loadConfig } from '../core/config.js';
import { promptChoice, promptLine } from '../core/prompt.js';
import { jsonMode, log } from '../core/logger.js';
import { formatIssue } from '../generate/validate.js';

/**
 * Interactive provider choice: shown when several providers could serve this
 * run and the user hasn't already decided (via --provider or a saved
 * preference). Scripts and pipes skip it — the router auto-picks as before.
 */
async function chooseProvider(): Promise<string | undefined> {
  const available = availableProviders();
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !jsonMode();
  if (available.length < 2 || loadConfig().router.prefer || !interactive) return undefined;

  const recommended = pickProvider()?.id;
  const choices = available.map((id) => {
    const p = PROVIDERS.find((x) => x.id === id)!;
    const notes = [
      p.needsKey ? 'API key' : id === 'ollama' ? 'local, free' : 'signed-in CLI, no key',
      id === recommended ? 'recommended' : '',
    ];
    return {
      value: id,
      label: `${p.name} ${pc.dim(`[${modelFor(p)}]`)}`,
      note: notes.filter(Boolean).join(' — '),
    };
  });
  log.title('Which AI should generate your kit?');
  const picked = await promptChoice(`Provider ${pc.dim(`[Enter = ${recommended}]`)}:`, choices);
  log.dim(`(skip this next time with --provider <id> or "devpilot router --prefer <id>")`);
  return picked ?? recommended;
}

/** Sentinel choice for "none of the listed models". */
const CUSTOM_MODEL = '\0custom';

/**
 * Interactive model choice for the provider serving this run, asked once and
 * then remembered under `router.models.<id>` — the same shape as a saved
 * `router.prefer` skipping the provider prompt above. An explicit --model, a
 * pipe, JSON mode, or a provider with nothing to choose between all skip it;
 * `devpilot router --model <provider> <model>` changes it later.
 *
 * The shipped catalogue is a starting point, never a whitelist: providers
 * ship models faster than DevPilot releases, so the last entry always accepts
 * a model id typed in full.
 */
async function chooseModel(providerId: string | undefined): Promise<void> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !jsonMode();
  if (!interactive) return;
  const spec = providerId ? PROVIDERS.find((p) => p.id === providerId) : pickProvider();
  if (!spec || hasModelChoice(spec.id)) return;

  // modelsFor puts the model currently in play first, so Enter keeps it.
  const models = await modelsFor(spec);
  const fallback = models[0]?.id;
  if (!fallback || models.length < 2) return;

  log.title(`Which ${spec.name} model should write your kit?`);
  const picked = await promptChoice(`Model ${pc.dim(`[Enter = ${fallback}]`)}:`, [
    ...models.map((m) => ({ value: m.id, label: m.id, note: m.note })),
    { value: CUSTOM_MODEL, label: 'type a model id…', note: 'anything this provider accepts' },
  ]);
  const model = (picked === CUSTOM_MODEL ? await promptLine('Model id: ') : picked) || fallback;

  saveModelChoice(spec.id, model);
  log.dim(`(saved — change it with "devpilot router --model ${spec.id} <model>")`);
}

/**
 * `devpilot generate --estimate` — what the run would cost, before spending
 * anything. Builds the real digest (no AI call) and reports the size of the
 * work: an honest range, since response length is unknowable up front.
 */
function estimateCommand(
  kinds: string[],
  opts: { provider?: string; ai?: boolean },
  cwd: string,
): number {
  const est = estimateGenerate({
    root: cwd,
    kinds,
    provider: opts.provider,
    force: false,
    dryRun: true,
    noAi: opts.ai === false,
  });

  if (jsonMode()) {
    log.json(est);
    return 0;
  }

  const k = (n: number): string => `${Math.round(n / 1000)}k`;
  log.title('Estimate for devpilot generate');
  log.info(
    `  Provider     ${est.provider ? `${est.provider} [${est.model}]` : 'none — static templates, no AI calls'}`,
  );
  log.info(`  Kinds        ${est.kinds.join(', ')}`);
  log.info(`  AI calls     ${est.calls}${est.calls ? ' (1 codebase review + 1 per kind)' : ''}`);
  log.info(`  Digest       ${k(est.digestChars)} chars of your codebase`);

  if (!est.provider) {
    // A forced-but-unavailable provider must not read as a deliberate choice.
    if (opts.provider) {
      log.warn(
        `Provider "${opts.provider}" is not available — add its key with ${pc.bold(`devpilot auth ${opts.provider}`)}. ` +
          `Estimated for a static run instead.`,
      );
    }
    log.dim('\n  Static templates cost nothing and make no network call.');
    return 0;
  }

  log.info(`  Tokens       ~${k(est.inputTokens)} in, ~${k(est.outputTokens)} out (assumed)`);
  if (est.billedAs) {
    log.info(`  Cost         ${est.billedAs}`);
  } else if (est.usdLow !== null && est.usdHigh !== null) {
    log.info(`  Cost         ~$${est.usdLow.toFixed(2)}–$${est.usdHigh.toFixed(2)}`);
    if (est.priceSource === 'builtin') {
      log.dim(
        `  Using DevPilot's indicative list price for ${est.model}. Providers change prices — ` +
          `set your own under router.pricing.${est.model} in ~/.devpilot/config.json.`,
      );
    }
  } else if (est.calls) {
    log.info(`  Cost         unknown — no price on file for ${est.model}`);
    log.dim(
      `  Add one under router.pricing.${est.model} in ~/.devpilot/config.json ` +
        `({ "inputPerMTok": 3, "outputPerMTok": 15 }) to see a figure here.`,
    );
  }
  log.dim('\n  Estimates only. A cached codebase review removes one call; retries add calls.');
  return 0;
}

/**
 * `devpilot generate` — generate the complete AI kit for this project:
 * rules, subagents, skills, slash commands, prompts and a professional
 * docs suite,
 * tailored by AI when a provider is configured.
 */
export async function generateCommand(
  kinds: string[],
  opts: {
    provider?: string;
    force?: boolean;
    dryRun?: boolean;
    ai?: boolean;
    concurrency?: string;
    cache?: boolean;
    estimate?: boolean;
    model?: string;
  },
  cwd: string = process.cwd(),
): Promise<number> {
  const known = ARTIFACT_KINDS.map((k) => k.id);
  const unknown = kinds.filter((k) => !known.includes(k));
  if (unknown.length) {
    log.fail(`Unknown artifact kind(s): ${unknown.join(', ')}. Known: ${known.join(', ')}`);
    return 1;
  }

  let concurrency: number | undefined;
  if (opts.concurrency !== undefined) {
    concurrency = Number(opts.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      log.fail(`--concurrency must be a positive whole number (got "${opts.concurrency}").`);
      return 1;
    }
  }

  // --model applies to whichever provider serves the run, named or routed to.
  const applyModel = (): void => {
    if (!opts.model) return;
    const target = opts.provider ?? pickProvider()?.id;
    if (target) setRuntimeModel(target, opts.model);
  };

  if (opts.estimate) {
    applyModel();
    return estimateCommand(kinds, { provider: opts.provider, ai: opts.ai }, cwd);
  }

  if (opts.ai !== false && !opts.provider) {
    opts.provider = await chooseProvider();
  }
  applyModel();

  // Generation is AI-first: the whole point is content written after actually
  // reading the codebase. Offline templates are an explicit opt-in.
  if (opts.ai !== false && !pickProvider(opts.provider)) {
    if (opts.provider) {
      log.fail(
        `Provider "${opts.provider}" is not available. Add its key with ${pc.bold(`devpilot auth ${opts.provider}`)}.`,
      );
    } else {
      log.fail('devpilot generate reads your codebase with AI, but no AI provider is configured.');
      log.info(
        `\n  Use a signed-in CLI:  Claude Code (${pc.bold('claude')}), Codex (${pc.bold('codex login')}) or Gemini CLI (${pc.bold('gemini')}) — no API key needed` +
          `\n  Or add an API key:    ${pc.bold('devpilot auth anthropic')}  (or openai, google, openrouter)` +
          `\n  Or a local model:     install Ollama (${pc.bold('ollama serve')})` +
          `\n  Offline templates:    ${pc.bold('devpilot generate --no-ai')}  (explicitly skip AI)`,
      );
    }
    return 1;
  }

  // Only once the provider is known to work — no point choosing a model for a
  // provider the run is about to fail on.
  if (opts.ai !== false && !opts.model) await chooseModel(opts.provider);

  log.info(opts.dryRun ? 'Planning AI kit (dry run)…' : 'Generating AI kit…');
  const result = await runGenerate({
    root: cwd,
    kinds,
    provider: opts.provider,
    force: opts.force ?? false,
    dryRun: opts.dryRun ?? false,
    noAi: opts.ai === false,
    concurrency,
    noCache: opts.cache === false,
  });

  if (jsonMode()) {
    log.json(result);
    return result.failed.length ? 1 : 0;
  }

  const written = result.files.filter((f) => f.action === 'written');
  const planned = result.files.filter((f) => f.action === 'planned');
  const skipped = result.files.filter((f) => f.action === 'skipped-exists');
  const rejected = result.files.filter((f) => f.action === 'rejected-path');

  for (const f of written) log.ok(`${f.file} ${pc.dim(`(${f.kind}, ${f.source})`)}`);
  for (const f of planned)
    log.info(`${pc.cyan('→')} would write ${f.file} ${pc.dim(`(${f.kind})`)}`);
  for (const f of result.propagated) log.ok(`${f} ${pc.dim('(rules propagated)')}`);
  for (const f of skipped) log.dim(`  kept existing ${f.file} (use --force to overwrite)`);
  for (const f of rejected) log.warn(`rejected unsafe path from provider: ${f.file}`);

  // Claims the project contradicts survived a retry, so they are on disk now.
  // Reporting them beats silence: an invented script reads as authority to the
  // next assistant that opens the file.
  if (result.issues.length) {
    log.warn(
      `\n${result.issues.length} claim${result.issues.length === 1 ? '' : 's'} in the generated content ` +
        `${result.issues.length === 1 ? 'does' : 'do'} not match this project:`,
    );
    for (const issue of result.issues.slice(0, 10)) log.warn(`  ${formatIssue(issue)}`);
    if (result.issues.length > 10) log.dim(`  …and ${result.issues.length - 10} more`);
    log.dim(`  Fix them in place, or re-run with ${pc.bold('--force')} for a fresh attempt.`);
  }

  if (result.failed.length) {
    if (result.aborted) {
      log.warn(`Stopped early — the provider hit a limit: ${result.aborted.slice(0, 200)}`);
    }
    log.warn(`Not generated yet: ${result.failed.join(', ')}.`);
    log.info(
      `\nEverything already written is kept. Re-run ${pc.bold('devpilot generate')} later ` +
        `(e.g. when your usage window resets) — it continues where it left off, ` +
        `or route elsewhere now with ${pc.bold('--provider')}.`,
    );
    return 1;
  }

  if (!written.length && !planned.length && !result.propagated.length) {
    log.ok('Everything already exists — nothing to do (use --force to regenerate).');
  } else if (!opts.dryRun) {
    log.info(
      `\nYour project is AI-ready: rules, agents, skills, commands and docs are in place.` +
        (result.provider
          ? ''
          : `\nNote: generated from offline templates (--no-ai). Re-run with AI + --force for tailored content.`),
    );
  }
  return 0;
}
