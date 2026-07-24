import pc from 'picocolors';
import { analyzeProject } from '../scan/analyzer.js';
import { pickProvider, runGenerate } from '../generate/pipeline.js';
import {
  diffFingerprints,
  fileStates,
  fingerprintOf,
  MANIFEST_FILE,
  readManifest,
} from '../generate/manifest.js';
import { jsonMode, log } from '../core/logger.js';

/**
 * `devpilot sync` — keep the generated AI kit alive after `generate`:
 * detect when the codebase has drifted from the kit recorded in
 * .devpilot/manifest.json, then refresh only what is safe to refresh —
 * hand-edited files are always preserved. `--check` reports and sets the
 * exit code without writing, which is what CI runs.
 */
export async function syncCommand(
  opts: { check?: boolean; provider?: string; dryRun?: boolean; ai?: boolean },
  cwd: string = process.cwd(),
): Promise<number> {
  const manifest = readManifest(cwd);
  if (!manifest) {
    log.fail(
      `No kit manifest found (${MANIFEST_FILE}). Run ${pc.bold('devpilot generate')} first — ` +
        `generate records what it wrote so sync can keep it fresh.`,
    );
    return 1;
  }

  const analysis = analyzeProject(cwd);
  const drift = diffFingerprints(manifest.fingerprint, fingerprintOf(analysis));
  const states = fileStates(cwd, manifest);
  const stale = drift.length > 0 || states.missing.length > 0;

  if (jsonMode() && opts.check) {
    log.json({ inSync: !stale, drift, ...states });
    return stale ? 1 : 0;
  }

  for (const d of drift) log.info(`${pc.yellow('△')} ${d}`);
  for (const f of states.missing) log.info(`${pc.yellow('△')} generated file deleted: ${f}`);
  for (const f of states.edited) log.dim(`  hand-edited, will be preserved: ${f}`);

  if (!stale) {
    log.ok(
      `Kit is in sync with the codebase (${Object.keys(manifest.files).length} tracked files` +
        `${states.edited.length ? `, ${states.edited.length} hand-edited` : ''}).`,
    );
    log.dim(`  last generated ${manifest.generatedAt} by devpilot ${manifest.devpilot}`);
    return 0;
  }

  if (opts.check) {
    log.warn(
      `Kit is stale: ${drift.length} drift signal${drift.length === 1 ? '' : 's'}, ` +
        `${states.missing.length} missing file${states.missing.length === 1 ? '' : 's'}. ` +
        `Run ${pc.bold('devpilot sync')} to refresh.`,
    );
    return 1;
  }

  // Refresh: regenerate the kit, overwriting only files the user never
  // touched (their hash still matches the manifest). Edited files are
  // skipped by the pipeline exactly like pre-existing files.
  if (opts.ai !== false && !pickProvider(opts.provider)) {
    if (opts.provider) {
      log.fail(
        `Provider "${opts.provider}" is not available. Add its key with ${pc.bold(`devpilot auth ${opts.provider}`)}.`,
      );
    } else {
      log.fail(
        'devpilot sync refreshes your kit with AI, but no AI provider is configured. ' +
          `Sign in to an AI CLI, run ${pc.bold('devpilot auth <provider>')}, or use ${pc.bold('devpilot sync --no-ai')} for static templates.`,
      );
    }
    return 1;
  }

  log.info(opts.dryRun ? 'Planning kit refresh (dry run)…' : 'Refreshing the AI kit…');
  const result = await runGenerate({
    root: cwd,
    kinds: [],
    provider: opts.provider,
    force: false,
    dryRun: opts.dryRun ?? false,
    noAi: opts.ai === false,
    refresh: states.clean,
  });

  if (jsonMode()) {
    log.json({ drift, ...states, result });
    return result.failed.length ? 1 : 0;
  }

  const written = result.files.filter((f) => f.action === 'written');
  const planned = result.files.filter((f) => f.action === 'planned');
  for (const f of written) log.ok(`refreshed ${f.file} ${pc.dim(`(${f.kind}, ${f.source})`)}`);
  for (const f of planned) log.info(`${pc.cyan('→')} would refresh ${f.file}`);
  for (const f of result.propagated) log.ok(`${f} ${pc.dim('(rules propagated)')}`);

  if (result.failed.length) {
    if (result.aborted) {
      log.warn(`Stopped early — the provider hit a limit: ${result.aborted.slice(0, 200)}`);
    }
    log.warn(
      `Not refreshed yet: ${result.failed.join(', ')}. Re-run ${pc.bold('devpilot sync')} later.`,
    );
    return 1;
  }
  if (!opts.dryRun) {
    log.info(
      `\nKit refreshed.${states.edited.length ? ` Preserved ${states.edited.length} hand-edited file${states.edited.length === 1 ? '' : 's'}.` : ''}`,
    );
  }
  return 0;
}
