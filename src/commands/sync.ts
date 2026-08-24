import pc from 'picocolors';
import { analyzeProject } from '../scan/analyzer.js';
import { mirrorTools, pickProvider, runGenerate } from '../generate/pipeline.js';
import { setRuntimeModel } from '../providers/router.js';
import {
  diffFingerprints,
  fileStates,
  fingerprintOf,
  MANIFEST_FILE,
  readManifest,
} from '../generate/manifest.js';
import { jsonMode, log } from '../core/logger.js';
import { generateRules, staleMirrors } from '../rules/generators.js';

/** The canonical rules file, as recorded in the manifest. */
const RULES_FILE = '.meridian/rules.md';

/**
 * `meridian sync` — keep the generated AI kit alive after `generate`:
 * detect when the codebase has drifted from the kit recorded in
 * .meridian/manifest.json, then refresh only what is safe to refresh —
 * hand-edited files are always preserved. `--check` reports and sets the
 * exit code without writing, which is what CI runs.
 */
export async function syncCommand(
  opts: {
    check?: boolean;
    provider?: string;
    dryRun?: boolean;
    ai?: boolean;
    concurrency?: string;
    cache?: boolean;
    model?: string;
  },
  cwd: string = process.cwd(),
): Promise<number> {
  let concurrency: number | undefined;
  if (opts.concurrency !== undefined) {
    concurrency = Number(opts.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      log.fail(`--concurrency must be a positive whole number (got "${opts.concurrency}").`);
      return 1;
    }
  }

  // --model applies to whichever provider serves the refresh.
  if (opts.model) {
    const target = opts.provider ?? pickProvider()?.id;
    if (target) setRuntimeModel(target, opts.model);
  }

  const manifest = readManifest(cwd);
  if (!manifest) {
    log.fail(
      `No kit manifest found (${MANIFEST_FILE}). Run ${pc.bold('meridian generate')} first — ` +
        `generate records what it wrote so sync can keep it fresh.`,
    );
    return 1;
  }

  const analysis = analyzeProject(cwd);
  const drift = diffFingerprints(manifest.fingerprint, fingerprintOf(analysis));
  const states = fileStates(cwd, manifest);
  // A hand-edited .meridian/rules.md whose tool files still carry the old text is
  // the kit's own documented workflow half-applied: propagate it here, because
  // regenerating the rules kind would overwrite the edit instead of spreading it.
  //
  // Gated on the canonical file being the edited one. A hand-edit to a mirror
  // is a different situation the kit already covers — it is overwritten on the
  // next generate — and must not start failing `--check`.
  const rulesEdited = states.edited.some((f) => f.replace(/\\/g, '/') === RULES_FILE);
  const mirrors = rulesEdited ? staleMirrors(cwd, analysis.name, mirrorTools({ root: cwd })) : [];
  const stale = drift.length > 0 || states.missing.length > 0;

  if (jsonMode() && opts.check) {
    log.json({ inSync: !stale && !mirrors.length, drift, staleMirrors: mirrors, ...states });
    return stale || mirrors.length ? 1 : 0;
  }

  for (const d of drift) log.info(`${pc.yellow('△')} ${d}`);
  for (const f of mirrors) log.info(`${pc.yellow('△')} out of date with .meridian/rules.md: ${f}`);
  for (const f of states.missing) log.info(`${pc.yellow('△')} generated file deleted: ${f}`);
  for (const f of states.edited) log.dim(`  hand-edited, will be preserved: ${f}`);

  // Mirrors are re-rendered from the rules file itself — no AI call, no
  // regeneration, so a hand-edited rules.md survives and reaches every tool.
  if (mirrors.length && !opts.check) {
    for (const g of generateRules(cwd, analysis.name, mirrorTools({ root: cwd })))
      log.ok(`${g.file} ${pc.dim('(rules propagated)')}`);
  }

  if (!stale) {
    if (mirrors.length) {
      if (opts.check) {
        log.fail(
          `${mirrors.length} tool file(s) no longer match .meridian/rules.md. Run ${pc.bold('meridian sync')}.`,
        );
        return 1;
      }
      return 0;
    }
    log.ok(
      `Kit is in sync with the codebase (${Object.keys(manifest.files).length} tracked files` +
        `${states.edited.length ? `, ${states.edited.length} hand-edited` : ''}).`,
    );
    log.dim(`  last generated ${manifest.generatedAt} by meridian ${manifest.meridian}`);
    return 0;
  }

  if (opts.check) {
    log.warn(
      `Kit is stale: ${drift.length} drift signal${drift.length === 1 ? '' : 's'}, ` +
        `${states.missing.length} missing file${states.missing.length === 1 ? '' : 's'}. ` +
        `Run ${pc.bold('meridian sync')} to refresh.`,
    );
    return 1;
  }

  // Refresh: regenerate the kit, overwriting only files the user never
  // touched (their hash still matches the manifest). Edited files are
  // skipped by the pipeline exactly like pre-existing files.
  if (opts.ai !== false && !pickProvider(opts.provider)) {
    if (opts.provider) {
      log.fail(
        `Provider "${opts.provider}" is not available. Add its key with ${pc.bold(`meridian auth ${opts.provider}`)}.`,
      );
    } else {
      log.fail(
        'meridian sync refreshes your kit with AI, but no AI provider is configured. ' +
          `Sign in to an AI CLI, run ${pc.bold('meridian auth <provider>')}, or use ${pc.bold('meridian sync --no-ai')} for static templates.`,
      );
    }
    return 1;
  }

  log.info(opts.dryRun ? 'Planning kit refresh (dry run)…' : 'Refreshing the AI kit…');
  const result = await runGenerate({
    // Keep the kit at the rigour it was generated with, not today's default.
    rigor: manifest.rigor,
    root: cwd,
    kinds: [],
    provider: opts.provider,
    force: false,
    dryRun: opts.dryRun ?? false,
    noAi: opts.ai === false,
    refresh: states.clean,
    concurrency,
    noCache: opts.cache === false,
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
      `Not refreshed yet: ${result.failed.join(', ')}. Re-run ${pc.bold('meridian sync')} later.`,
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
