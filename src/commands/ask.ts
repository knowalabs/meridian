import pc from 'picocolors';
import { availableProviders, modelFor, PROVIDERS, route } from '../providers/router.js';
import { openVault } from '../core/vault.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { jsonMode, log } from '../core/logger.js';
import { CliError } from '../core/errors.js';

export async function askCommand(
  promptParts: string[],
  opts: { provider?: string },
): Promise<number> {
  const prompt = promptParts.join(' ').trim();
  if (!prompt) {
    log.fail('Usage: devpilot ask "<your question>"');
    return 1;
  }

  const available = availableProviders();
  if (available.length === 0) {
    log.fail(
      `No providers configured. Add a key with ${pc.bold('devpilot auth')} (or install Ollama).`,
    );
    return 1;
  }

  let decision = route(prompt, available);
  if (opts.provider) {
    const forced = PROVIDERS.find((p) => p.id === opts.provider && available.includes(p.id));
    if (!forced) {
      log.fail(`Provider "${opts.provider}" is not available. Available: ${available.join(', ')}`);
      return 1;
    }
    decision = { provider: forced, reason: '--provider flag' };
  }
  if (!decision) {
    log.fail('No suitable provider found for this prompt.');
    return 1;
  }

  const { provider, reason } = decision;
  // Routing info is a diagnostic — log.dim sends it to stderr so that
  // `devpilot ask "…" | tool` pipes only the answer.
  log.dim(`→ routed to ${provider.name} [${modelFor(provider)}] (${reason})`);

  const key = provider.needsKey ? openVault().get(provider.id) : '';
  if (provider.needsKey && !key) {
    log.fail(
      `Key for ${provider.id} disappeared from the vault. Re-run ${pc.bold('devpilot auth')}.`,
    );
    return 1;
  }

  try {
    const answer = await provider.ask(prompt, key ?? '');
    if (jsonMode()) {
      log.json({ provider: provider.id, model: modelFor(provider), reason, answer: answer.trim() });
    } else {
      log.info('\n' + answer.trim());
    }
    return 0;
  } catch (err) {
    // CliErrors carry classified messages and hints (auth, timeout, rate
    // limit) — let the top-level/launcher boundary render them.
    if (err instanceof CliError) throw err;
    log.fail(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export function routerConfigCommand(opts: { prefer?: string; optimize?: string }): number {
  const config = loadConfig();
  if (opts.prefer !== undefined) {
    if (opts.prefer && !PROVIDERS.some((p) => p.id === opts.prefer)) {
      log.fail(
        `Unknown provider "${opts.prefer}". Supported: ${PROVIDERS.map((p) => p.id).join(', ')}`,
      );
      return 1;
    }
    config.router.prefer = opts.prefer || undefined;
  }
  if (opts.optimize !== undefined) {
    if (!['cost', 'speed', 'quality'].includes(opts.optimize)) {
      log.fail('--optimize must be one of: cost, speed, quality');
      return 1;
    }
    config.router.optimize = opts.optimize as 'cost' | 'speed' | 'quality';
  }
  saveConfig(config);
  log.ok(
    `Router config: prefer=${config.router.prefer ?? '(auto)'} optimize=${config.router.optimize}`,
  );
  return 0;
}
