import pc from 'picocolors';
import { ARTIFACT_KINDS } from '../generate/artifacts.js';
import { pickProvider, runGenerate } from '../generate/pipeline.js';
import { availableProviders, modelFor, PROVIDERS } from '../providers/router.js';
import { loadConfig } from '../core/config.js';
import { promptChoice } from '../core/prompt.js';
import { jsonMode, log } from '../core/logger.js';

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

/**
 * `devpilot generate` — generate the complete AI kit for this project:
 * rules, subagents, skills, slash commands, prompts and onboarding docs,
 * tailored by AI when a provider is configured.
 */
export async function generateCommand(
  kinds: string[],
  opts: { provider?: string; force?: boolean; dryRun?: boolean; ai?: boolean },
  cwd: string = process.cwd(),
): Promise<number> {
  const known = ARTIFACT_KINDS.map((k) => k.id);
  const unknown = kinds.filter((k) => !known.includes(k));
  if (unknown.length) {
    log.fail(`Unknown artifact kind(s): ${unknown.join(', ')}. Known: ${known.join(', ')}`);
    return 1;
  }

  if (opts.ai !== false && !opts.provider) {
    opts.provider = await chooseProvider();
  }

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

  log.info(opts.dryRun ? 'Planning AI kit (dry run)…' : 'Generating AI kit…');
  const result = await runGenerate({
    root: cwd,
    kinds,
    provider: opts.provider,
    force: opts.force ?? false,
    dryRun: opts.dryRun ?? false,
    noAi: opts.ai === false,
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
