import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { openVault } from '../core/vault.js';
import { runAsync, which } from '../core/exec.js';
import { CliError } from '../core/errors.js';

/**
 * AI Router (Phase 4): route a prompt to the most suitable provider based on
 * cost, speed, context size and user preference.
 */

export interface ProviderSpec {
  id: string;
  name: string;
  /** Default model; users can override via config `router.models.<id>`. */
  model: string;
  /** Relative ranking used by the router (1 = best in class). */
  cost: number; // lower = cheaper
  speed: number; // lower = faster
  quality: number; // lower = smarter
  contextTokens: number;
  needsKey: boolean;
  /** For keyless providers: the CLI binary that must be on PATH. */
  binary?: string;
  ask(prompt: string, apiKey: string): Promise<string>;
}

/** Model to use for a provider, honoring config overrides. */
export function modelFor(spec: Pick<ProviderSpec, 'id' | 'model'>): string {
  return loadConfig().router.models?.[spec.id] ?? spec.model;
}

/**
 * Sentinel model for CLI-backed providers whose model names churn: use
 * whatever the signed-in CLI is configured with, unless the user overrides
 * via `router.models.<id>`.
 */
export const CLI_DEFAULT_MODEL = 'cli-default';

const DEFAULT_TIMEOUT_MS = 60_000;

let fetchImpl: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);

/** Test seam: replace the fetch implementation (null restores the default). */
export function setFetchForTests(f: typeof globalThis.fetch | null): void {
  fetchImpl = f ?? ((...args) => globalThis.fetch(...args));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type CliRunner = (
  ...args: Parameters<typeof runAsync>
) => ReturnType<typeof runAsync> | Awaited<ReturnType<typeof runAsync>>;

let runImpl: CliRunner = runAsync;

/** Test seam: replace the CLI runner used by CLI-backed providers. */
export function setRunForTests(r: CliRunner | null): void {
  runImpl = r ?? runAsync;
}

interface PostContext {
  provider: string;
  timeoutMs?: number;
  retried?: boolean;
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: PostContext,
): Promise<unknown> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new CliError(`${ctx.provider}: request timed out after ${timeoutMs / 1000}s`, {
        hint: 'The provider did not respond. Check your connection or try another provider with --provider.',
      });
    }
    throw new CliError(
      `${ctx.provider}: network error — ${err instanceof Error ? err.message : String(err)}`,
      {
        hint:
          ctx.provider === 'ollama'
            ? 'Is the Ollama daemon running? Start it with "ollama serve".'
            : 'Check your internet connection and try again.',
        cause: err,
      },
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new CliError(`${ctx.provider}: authentication failed (HTTP ${res.status})`, {
      hint: `Your API key is missing, invalid or expired. Run "devpilot auth ${ctx.provider}" to update it.`,
    });
  }
  if (res.status === 429 && !ctx.retried) {
    await sleep(2_000);
    return post(url, headers, body, { ...ctx, retried: true });
  }
  if (res.status === 429) {
    throw new CliError(`${ctx.provider}: rate limited (HTTP 429)`, {
      hint: 'You hit the provider rate limit. Wait a moment, or route elsewhere with --provider.',
    });
  }
  if (res.status === 404) {
    throw new CliError(`${ctx.provider}: model or endpoint not found (HTTP 404)`, {
      hint: `The default model may have been retired. Override it in ${'~/.devpilot/config.json'} under router.models.${ctx.provider}.`,
    });
  }
  if (!res.ok) {
    throw new CliError(`${ctx.provider}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    model: 'claude-sonnet-5',
    cost: 3,
    speed: 2,
    quality: 1,
    contextTokens: 200_000,
    needsKey: true,
    async ask(prompt, apiKey) {
      const data = (await post(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: modelFor(this),
          // Multi-file artifact responses (e.g. the docs suite) need real
          // output headroom; 8k tokens silently truncated trailing files.
          max_tokens: 16_384,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        },
        { provider: this.id },
      )) as { content: { type: string; text?: string }[] };
      return data.content.map((b) => b.text ?? '').join('');
    },
  },
  {
    // Uses the locally installed Claude Code CLI — a Claude subscription
    // (Pro/Max) works with no API key at all.
    id: 'claude-code',
    name: 'Claude Code (subscription)',
    model: 'sonnet',
    cost: 0,
    speed: 3,
    quality: 1,
    contextTokens: 200_000,
    needsKey: false,
    binary: 'claude',
    async ask(prompt) {
      const res = await runImpl(
        'claude',
        ['-p', '--output-format', 'text', '--model', modelFor(this)],
        prompt,
        {
          timeoutMs: 600_000,
        },
      );
      if (res.notFound) {
        throw new CliError('claude-code: the "claude" CLI is not installed', {
          hint: 'Install it with "devpilot install claude", then run "claude" once to sign in.',
        });
      }
      if (res.error?.includes('ETIMEDOUT')) {
        throw new CliError('claude-code: the claude CLI did not respond within 10 minutes', {
          hint: 'Try again, or route elsewhere with --provider.',
        });
      }
      if (!res.ok) {
        throw new CliError(
          `claude-code: claude -p failed — ${(res.stderr || res.stdout || 'no output').slice(0, 300)}`,
          {
            hint: 'Run "claude" once to sign in with your subscription, then retry. A different model can be set in ~/.devpilot/config.json under router.models.claude-code.',
          },
        );
      }
      return res.stdout;
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    model: 'gpt-5',
    cost: 3,
    speed: 2,
    quality: 2,
    contextTokens: 128_000,
    needsKey: true,
    async ask(prompt, apiKey) {
      const data = (await post(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        { model: modelFor(this), messages: [{ role: 'user', content: prompt }] },
        { provider: this.id },
      )) as { choices: { message: { content: string } }[] };
      return data.choices[0]?.message.content ?? '';
    },
  },
  {
    // Uses the locally installed Codex CLI — a ChatGPT subscription works
    // with no API key. Runs read-only and skips the git-repo check.
    id: 'codex-cli',
    name: 'Codex CLI (subscription)',
    model: CLI_DEFAULT_MODEL,
    cost: 0,
    speed: 3,
    quality: 2,
    contextTokens: 200_000,
    needsKey: false,
    binary: 'codex',
    async ask(prompt) {
      const outFile = path.join(os.tmpdir(), `devpilot-codex-${process.pid}-${Date.now()}.txt`);
      const args = [
        'exec',
        '-',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '--color',
        'never',
        '-o',
        outFile,
      ];
      const model = modelFor(this);
      if (model !== CLI_DEFAULT_MODEL) args.push('-m', model);
      const res = await runImpl('codex', args, prompt, { timeoutMs: 600_000 });
      let last = '';
      try {
        last = fs.readFileSync(outFile, 'utf8').trim();
        fs.unlinkSync(outFile);
      } catch {
        /* fall back to stdout below */
      }
      if (res.notFound) {
        throw new CliError('codex-cli: the "codex" CLI is not installed', {
          hint: 'Install it with "devpilot install codex", then run "codex login".',
        });
      }
      if (res.error?.includes('ETIMEDOUT')) {
        throw new CliError('codex-cli: the codex CLI did not respond within 10 minutes', {
          hint: 'Try again, or route elsewhere with --provider.',
        });
      }
      if (!res.ok) {
        throw new CliError(
          `codex-cli: codex exec failed — ${(res.stderr || res.stdout || 'no output').slice(0, 300)}`,
          { hint: 'Run "codex login" to sign in with your ChatGPT account, then retry.' },
        );
      }
      return last || res.stdout;
    },
  },
  {
    id: 'google',
    name: 'Google Gemini',
    model: 'gemini-2.5-flash',
    cost: 1,
    speed: 1,
    quality: 3,
    contextTokens: 1_000_000,
    needsKey: true,
    async ask(prompt, apiKey) {
      const data = (await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelFor(this)}:generateContent?key=${apiKey}`,
        {},
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } },
        { provider: this.id },
      )) as { candidates: { content: { parts: { text: string }[] } }[] };
      return data.candidates[0]?.content.parts.map((p) => p.text).join('') ?? '';
    },
  },
  {
    // Uses the locally installed Gemini CLI — a Google account sign-in
    // (the Antigravity/Gemini ecosystem) works with no API key.
    id: 'gemini-cli',
    name: 'Gemini CLI (Google account)',
    model: CLI_DEFAULT_MODEL,
    cost: 0,
    speed: 3,
    quality: 3,
    contextTokens: 1_000_000,
    needsKey: false,
    binary: 'gemini',
    async ask(prompt) {
      const args: string[] = [];
      const model = modelFor(this);
      if (model !== CLI_DEFAULT_MODEL) args.push('-m', model);
      const res = await runImpl('gemini', args, prompt, { timeoutMs: 600_000 });
      if (res.notFound) {
        throw new CliError('gemini-cli: the "gemini" CLI is not installed', {
          hint: 'Install it with "devpilot install gemini", then run "gemini" once to sign in with your Google account.',
        });
      }
      if (res.error?.includes('ETIMEDOUT')) {
        throw new CliError('gemini-cli: the gemini CLI did not respond within 10 minutes', {
          hint: 'Try again, or route elsewhere with --provider.',
        });
      }
      if (!res.ok) {
        throw new CliError(
          `gemini-cli: gemini failed — ${(res.stderr || res.stdout || 'no output').slice(0, 300)}`,
          { hint: 'Run "gemini" once to sign in with your Google account, then retry.' },
        );
      }
      return res.stdout;
    },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    model: 'openrouter/auto',
    cost: 2,
    speed: 3,
    quality: 2,
    contextTokens: 200_000,
    needsKey: true,
    async ask(prompt, apiKey) {
      const data = (await post(
        'https://openrouter.ai/api/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        { model: modelFor(this), temperature: 0.2, messages: [{ role: 'user', content: prompt }] },
        { provider: this.id },
      )) as { choices: { message: { content: string } }[] };
      return data.choices[0]?.message.content ?? '';
    },
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    model: 'llama3.2',
    cost: 0,
    speed: 4,
    quality: 4,
    contextTokens: 32_000,
    needsKey: false,
    binary: 'ollama',
    async ask(prompt) {
      const data = (await post(
        'http://localhost:11434/api/generate',
        {},
        { model: modelFor(this), prompt, stream: false, options: { temperature: 0.2 } },
        { provider: this.id },
      )) as { response: string };
      return data.response;
    },
  },
];

export interface RouteDecision {
  provider: ProviderSpec;
  reason: string;
}

/** Pick the best available provider for a prompt. */
export function route(prompt: string, availableIds: string[]): RouteDecision | null {
  const config = loadConfig();
  const available = PROVIDERS.filter((p) => availableIds.includes(p.id));
  if (available.length === 0) return null;

  if (config.router.prefer) {
    const preferred = available.find((p) => p.id === config.router.prefer);
    if (preferred) return { provider: preferred, reason: `user preference (${preferred.id})` };
  }

  // Rough token estimate; providers that can't fit the context are excluded.
  const estTokens = Math.ceil(prompt.length / 4);
  const fitting = available.filter((p) => p.contextTokens >= estTokens * 1.2);
  const pool = fitting.length ? fitting : available;

  const metric = config.router.optimize ?? 'quality';
  const key: 'cost' | 'speed' | 'quality' =
    metric === 'cost' ? 'cost' : metric === 'speed' ? 'speed' : 'quality';
  const best = [...pool].sort((a, b) => a[key] - b[key])[0]!;
  return { provider: best, reason: `optimized for ${metric}, context ~${estTokens} tokens` };
}

export type KeyVerification = 'valid' | 'invalid' | 'unreachable';

/** Cheap authenticated GET per provider, used to validate keys before storing. */
const KEY_CHECKS: Record<
  string,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  anthropic: (k) => ({
    url: 'https://api.anthropic.com/v1/models',
    headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
  }),
  openai: (k) => ({
    url: 'https://api.openai.com/v1/models',
    headers: { authorization: `Bearer ${k}` },
  }),
  google: (k) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${k}`,
    headers: {},
  }),
  openrouter: (k) => ({
    url: 'https://openrouter.ai/api/v1/key',
    headers: { authorization: `Bearer ${k}` },
  }),
};

/**
 * Check a key against the provider's API without spending tokens.
 * `invalid` = provider rejected the key; `unreachable` = we couldn't tell
 * (offline, provider down) — callers should store with a warning, not block.
 */
export async function verifyApiKey(providerId: string, apiKey: string): Promise<KeyVerification> {
  const check = KEY_CHECKS[providerId];
  if (!check) return 'valid'; // no checker for this provider — don't block
  const { url, headers } = check(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (res.status === 401 || res.status === 403) return 'invalid';
    // Google reports a bad key as 400 API_KEY_INVALID.
    if (providerId === 'google' && res.status === 400) return 'invalid';
    if (res.ok || res.status === 429) return 'valid'; // 429 still proves the key is accepted
    return 'unreachable'; // 5xx etc. — provider trouble, can't tell
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

/** Providers usable right now (key in vault, or a CLI/daemon on PATH). */
export function availableProviders(): string[] {
  const vault = openVault();
  const keys = vault.list();
  // Opt-out for specific providers, e.g. DEVPILOT_DISABLE_PROVIDERS=claude-code,ollama
  const disabled = new Set(
    (process.env.DEVPILOT_DISABLE_PROVIDERS ?? '').split(',').map((s) => s.trim()),
  );
  return PROVIDERS.filter(
    (p) =>
      !disabled.has(p.id) &&
      (!p.needsKey || keys.includes(p.id)) &&
      (!p.binary || which(p.binary) !== null),
  ).map((p) => p.id);
}
