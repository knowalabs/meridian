import pc from 'picocolors';
import { ARTIFACT_KINDS } from '../generate/artifacts.js';
import { runGenerate } from '../generate/pipeline.js';
import { jsonMode, log } from '../core/logger.js';

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

  log.info(opts.dryRun ? 'Planning AI kit (dry run)…' : 'Generating AI kit…');
  const result = await runGenerate({
    root: cwd,
    kinds,
    provider: opts.provider,
    force: opts.force ?? false,
    dryRun: opts.dryRun ?? false,
    noAi: opts.ai === false,
  });

  if (opts.provider && result.provider === null) {
    log.fail(
      `Provider "${opts.provider}" is not available. Add a key with ${pc.bold('devpilot auth')}.`,
    );
    return 1;
  }

  if (jsonMode()) {
    log.json(result);
    return 0;
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
  if (result.degraded.length)
    log.warn(`AI failed for: ${result.degraded.join(', ')} — static fallbacks were used.`);

  if (!written.length && !planned.length && !result.propagated.length) {
    log.ok('Everything already exists — nothing to do (use --force to regenerate).');
  } else if (!opts.dryRun) {
    log.info(
      `\nYour project is AI-ready: rules, agents, skills, commands and docs are in place.` +
        (result.provider
          ? ''
          : `\nTip: add an API key (${pc.bold('devpilot auth')}) and re-run with --force for AI-tailored content.`),
    );
  }
  return 0;
}
