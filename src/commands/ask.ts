import fs from 'node:fs';
import pc from 'picocolors';
import {
  availableProviders,
  modelFor,
  PROVIDERS,
  route,
  saveModelChoice,
  setRuntimeModel,
} from '../providers/router.js';
import { openVault } from '../core/vault.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { jsonMode, log } from '../core/logger.js';
import { CliError } from '../core/errors.js';

/** Give up on stdin if not a single byte arrives in this long. */
const STDIN_FIRST_BYTE_MS = 250;

/**
 * Piped input becomes context for the question, so `cat error.log | devpilot
 * ask "what failed?"` works. Returns '' when stdin is a terminal, empty, or
 * an idle stream: a pipe that is open but silent (a CI runner, a background
 * job) must never leave the command hanging forever waiting for EOF.
 */
async function readPipedInput(): Promise<string> {
  if (process.stdin.isTTY) return '';
  try {
    const stat = fs.fstatSync(0);
    if (!stat.isFIFO() && !stat.isFile()) return '';
  } catch {
    return '';
  }

  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    };
    // Only the wait for the *first* byte is bounded; once input is flowing we
    // read it to the end however long that takes.
    const idle = setTimeout(finish, STDIN_FIRST_BYTE_MS);

    process.stdin.on('data', (chunk: Buffer) => {
      clearTimeout(idle);
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
    process.stdin.resume();
  });
}

export async function askCommand(
  promptParts: string[],
  opts: { provider?: string; model?: string },
): Promise<number> {
  const question = promptParts.join(' ').trim();
  const piped = await readPipedInput();
  if (!question && !piped) {
    log.fail('Usage: devpilot ask "<your question>"   (or pipe input: cat file | devpilot ask …)');
    return 1;
  }
  const prompt = piped
    ? `${question || 'Explain this input.'}\n\n--- INPUT ---\n${piped}`
    : question;

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
  if (opts.model) setRuntimeModel(provider.id, opts.model);
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

  // Stream to a human at a terminal; buffer when the answer is being piped or
  // rendered as JSON, where partial writes would corrupt the output.
  const streamer = provider.askStream?.bind(provider) ?? null;
  const stream = streamer !== null && !jsonMode() && process.stdout.isTTY === true;

  try {
    let answer: string;
    if (stream && streamer) {
      process.stdout.write('\n');
      answer = await streamer(prompt, key ?? '', (delta) => process.stdout.write(delta));
      process.stdout.write('\n');
    } else {
      answer = await provider.ask(prompt, key ?? '');
      if (jsonMode()) {
        log.json({
          provider: provider.id,
          model: modelFor(provider),
          reason,
          answer: answer.trim(),
        });
      } else {
        log.info('\n' + answer.trim());
      }
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

export function routerConfigCommand(opts: {
  prefer?: string;
  optimize?: string;
  model?: string[];
}): number {
  const config = loadConfig();
  if (opts.model !== undefined) {
    const [provider, model] = opts.model;
    if (!provider || !PROVIDERS.some((p) => p.id === provider)) {
      log.fail(
        `--model needs a provider first: devpilot router --model <provider> <model>. ` +
          `Supported: ${PROVIDERS.map((p) => p.id).join(', ')}`,
      );
      return 1;
    }
    // Omitting the model clears the override, restoring the provider default.
    saveModelChoice(provider, model ?? '');
    const spec = PROVIDERS.find((p) => p.id === provider)!;
    log.ok(
      model
        ? `${provider} will use ${model}.`
        : `${provider} is back to its default model (${spec.model}).`,
    );
    return 0;
  }
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
