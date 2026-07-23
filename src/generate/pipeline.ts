import fs from 'node:fs';
import path from 'node:path';
import { ProjectAnalysis } from '../scan/analyzer.js';
import { availableProviders, modelFor, PROVIDERS, ProviderSpec, route } from '../providers/router.js';
import { openVault } from '../core/vault.js';
import { writeFileAtomic } from '../core/fsx.js';
import { generateRules } from '../rules/generators.js';
import { log } from '../core/logger.js';
import { buildDigest } from './digest.js';
import { ArtifactFile, ArtifactKind, isAllowedPath, kindsById, parseFileBlocks } from './artifacts.js';

/**
 * Generation pipeline (Phase 5): scan the project, ask an AI provider for
 * project-tailored artifacts kind by kind, validate every returned path and
 * write the files. Falls back to static generation per kind when no provider
 * is available or a call fails — `devpilot generate` always produces a
 * complete kit.
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
  /** Kinds where the AI call failed and the static fallback was used. */
  degraded: string[];
}

function pickProvider(forced?: string): ProviderSpec | null {
  const available = availableProviders();
  if (forced) {
    const p = PROVIDERS.find((p) => p.id === forced);
    if (!p || !available.includes(p.id)) return null;
    return p;
  }
  return route('generate ai project artifacts', available)?.provider ?? null;
}

async function generateKind(
  kind: ArtifactKind,
  digest: string,
  provider: ProviderSpec | null,
  apiKey: string,
  analysis: ProjectAnalysis,
): Promise<{ files: ArtifactFile[]; source: 'ai' | 'static'; degraded: boolean }> {
  if (provider) {
    try {
      const response = await provider.ask(kind.prompt(digest), apiKey);
      const files = parseFileBlocks(response);
      if (files.length > 0) return { files, source: 'ai', degraded: false };
      log.warn(`${kind.name}: provider returned no file blocks — using static fallback.`);
    } catch (err) {
      log.warn(
        `${kind.name}: AI call failed (${err instanceof Error ? err.message : String(err)}) — using static fallback.`,
      );
    }
    return { files: kind.fallback(analysis), source: 'static', degraded: true };
  }
  return { files: kind.fallback(analysis), source: 'static', degraded: false };
}

export async function runGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const kinds = kindsById(opts.kinds);
  const digest = buildDigest(opts.root);
  const analysis = digest.analysis;

  const provider = opts.noAi ? null : pickProvider(opts.provider);
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
    degraded: [],
  };

  for (const kind of kinds) {
    const { files, source, degraded } = await generateKind(
      kind,
      digest.text,
      provider,
      apiKey,
      analysis,
    );
    if (degraded) result.degraded.push(kind.id);

    for (const f of files) {
      if (!isAllowedPath(f.file, kind.allowedPaths)) {
        result.files.push({ kind: kind.id, file: f.file, action: 'rejected-path', source });
        continue;
      }
      const target = path.join(opts.root, f.file);
      if (fs.existsSync(target) && !opts.force) {
        result.files.push({ kind: kind.id, file: f.file, action: 'skipped-exists', source });
        continue;
      }
      if (opts.dryRun) {
        result.files.push({ kind: kind.id, file: f.file, action: 'planned', source });
        continue;
      }
      writeFileAtomic(target, f.content);
      result.files.push({ kind: kind.id, file: f.file, action: 'written', source });
    }

    // Fresh rules should reach every tool's instruction file.
    if (kind.id === 'rules' && !opts.dryRun) {
      const wroteRules = result.files.some(
        (f) => f.kind === 'rules' && f.action === 'written',
      );
      if (wroteRules) {
        result.propagated = generateRules(opts.root, analysis.name).map((g) => g.file);
      }
    }
  }
  return result;
}
