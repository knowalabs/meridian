import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../core/config.js';
import { openVault } from '../core/vault.js';
import { runAsync, which } from '../core/exec.js';
import { CliError } from '../core/errors.js';

/**
 * AI Router (Phase 4): route a prompt to the most suitable provider based on
 * cost, speed, context size and user preference.
 */

/** One selectable model version, as offered by the interactive picker. */
export interface ModelOption {
  /** The id sent to the provider — exactly what goes in `router.models.<id>`. */
  id: string;
  /** One short line on what this model is for, shown beside it in the picker. */
  note: string;
}

export interface ProviderSpec {
  id: string;
  name: string;
  /** Default model; users can override via config `router.models.<id>`. */
  model: string;
  /**
   * Model versions the picker offers, best first. DevPilot ships a starting
   * set per provider — it is deliberately not exhaustive, and providers
   * release faster than DevPilot does, so the picker always offers free-text
   * entry and `router.models.<id>` accepts any string. Omit for a provider
   * whose catalogue cannot be usefully enumerated (OpenRouter's thousands of
   * models) or is per-machine (Ollama, discovered live instead).
   */
  models?: ModelOption[];
  /** Relative ranking used by the router (1 = best in class). */
  cost: number; // lower = cheaper
  speed: number; // lower = faster
  quality: number; // lower = smarter
  contextTokens: number;
  needsKey: boolean;
  /** For keyless providers: the CLI binary that must be on PATH. */
  binary?: string;
  /**
   * Requests this provider can serve at once without degrading. Hosted APIs
   * are happy with a handful; a CLI spawns a process per call; a local model
   * server is slower in parallel than in sequence.
   */
  parallel?: number;
  ask(prompt: string, apiKey: string): Promise<string>;
  /**
   * Same answer as `ask`, delivered incrementally. Present only for providers
   * that stream over HTTP; `devpilot ask` falls back to `ask` without it.
   */
  askStream?(prompt: string, apiKey: string, onDelta: (text: string) => void): Promise<string>;
}

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Indicative list prices in USD per million tokens, keyed by *model* — the
 * unit that is actually billed. Providers whose model is overridden, or whose
 * model is not listed here, simply report no cost rather than a wrong one.
 * Users can add or correct entries under `router.pricing.<model>` in
 * ~/.devpilot/config.json, which always wins over this table.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

/** Price for a model, preferring the user's config over the built-in table. */
export function pricingFor(
  model: string,
): { price: ModelPricing; source: 'config' | 'builtin' } | null {
  const configured = loadConfig().router.pricing?.[model];
  if (configured) return { price: configured, source: 'config' };
  const builtin = MODEL_PRICING[model];
  return builtin ? { price: builtin, source: 'builtin' } : null;
}

/** Per-run `--model` overrides; they outrank the saved config. */
const runtimeModels = new Map<string, string>();

/**
 * Override the model for this process only (the `--model` flag). Passing null
 * clears every override — commands are run in-process by the interactive
 * launcher, so a flag from one command must not leak into the next.
 */
export function setRuntimeModel(providerId: string | null, model?: string): void {
  if (providerId === null) runtimeModels.clear();
  else if (model) runtimeModels.set(providerId, model);
}

/** Model to use for a provider: --model, then config, then the default. */
export function modelFor(spec: Pick<ProviderSpec, 'id' | 'model'>): string {
  return runtimeModels.get(spec.id) ?? loadConfig().router.models?.[spec.id] ?? spec.model;
}

/**
 * True when the user has already chosen a model for this provider. The
 * interactive picker asks once and records the answer, so a saved choice
 * skips the prompt the same way a saved `router.prefer` skips the provider
 * prompt.
 */
export function hasModelChoice(providerId: string): boolean {
  return Boolean(loadConfig().router.models?.[providerId]);
}

/** Record the model for a provider (empty clears it, restoring the default). */
export function saveModelChoice(providerId: string, model: string): void {
  const config = loadConfig();
  const models = { ...config.router.models };
  if (model) models[providerId] = model;
  else delete models[providerId];
  config.router.models = Object.keys(models).length > 0 ? models : undefined;
  saveConfig(config);
}

/**
 * Models installed on this machine, read from the local Ollama daemon. A
 * shipped list would be wrong for every user — they run whatever they pulled
 * — so this is the one provider whose catalogue is discovered rather than
 * declared. Best-effort: any failure just leaves the configured model.
 */
async function installedOllamaModels(): Promise<ModelOption[]> {
  try {
    const result = await runImpl('ollama', ['list']);
    if (!result.ok) return [];
    return result.stdout
      .split(/\r?\n/)
      .slice(1) // `ollama list` prints a NAME/ID/SIZE header row
      .map((line) => line.trim().split(/\s+/)[0] ?? '')
      .filter(Boolean)
      .map((id) => ({ id, note: 'installed locally' }));
  } catch {
    return [];
  }
}

/**
 * The model versions to offer for a provider: its shipped catalogue plus
 * anything discovered on this machine. The model actually in play always
 * comes first and is always present — a model set through config or a
 * previous `--model` must stay selectable even when it predates the
 * catalogue or postdates this release.
 */
export async function modelsFor(spec: ProviderSpec): Promise<ModelOption[]> {
  const discovered = spec.id === 'ollama' ? await installedOllamaModels() : [];
  const current = modelFor(spec);
  const options: ModelOption[] = [];
  for (const option of [...(spec.models ?? []), ...discovered]) {
    if (!options.some((o) => o.id === option.id)) options.push(option);
  }
  const currentIndex = options.findIndex((o) => o.id === current);
  const [existing] = currentIndex >= 0 ? options.splice(currentIndex, 1) : [];
  options.unshift(existing ?? { id: current, note: 'in use' });
  return options;
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
}

/**
 * Statuses worth trying again: rate limits and the transient server/proxy
 * failures every provider emits occasionally. A `generate` run makes one call
 * per artifact kind, so a single 502 used to cost the user a whole kind.
 * 4xx codes that mean "your request is wrong" are never retried.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;

let retryBaseMs = DEFAULT_RETRY_BASE_MS;

/**
 * Test seam: shrink the retry backoff (null restores it). Tests that exercise
 * the pipeline end to end would otherwise sit through real seconds of sleep.
 */
export function setRetryDelayForTests(ms: number | null): void {
  retryBaseMs = ms ?? DEFAULT_RETRY_BASE_MS;
}

const backoffFor = (attempt: number): number => retryBaseMs * 2 ** (attempt - 1);

/** Honor Retry-After (seconds, or an HTTP date), capped so we never hang. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 30_000) : null;
}

/** Internal marker: a connection-level failure that is worth one more try. */
class TransientNetworkError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'TransientNetworkError';
  }
}

async function rawPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: PostContext,
): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // A timeout is deliberate, not transient: retrying a hung provider just
    // multiplies the wait, so it is reported instead of retried.
    if (controller.signal.aborted) {
      throw new CliError(`${ctx.provider}: request timed out after ${timeoutMs / 1000}s`, {
        hint: 'The provider did not respond. Check your connection or try another provider with --provider.',
      });
    }
    throw new TransientNetworkError(err);
  } finally {
    clearTimeout(timer);
  }
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: PostContext,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= MAX_ATTEMPTS;
    let res: Response;
    try {
      res = await rawPost(url, headers, body, ctx);
    } catch (err) {
      if (err instanceof TransientNetworkError && !last) {
        await sleep(backoffFor(attempt));
        continue;
      }
      if (err instanceof TransientNetworkError) {
        throw new CliError(`${ctx.provider}: network error — ${err.message}`, {
          hint:
            ctx.provider === 'ollama'
              ? 'Is the Ollama daemon running? Start it with "ollama serve".'
              : 'Check your internet connection and try again.',
          cause: err.reason,
        });
      }
      throw err;
    }

    const failure = await classifyStatus(res, ctx, last);
    if (failure === 'retry') {
      await sleep(retryAfterMs(res) ?? backoffFor(attempt));
      continue;
    }
    return res.json();
  }
}

/**
 * Turn a non-OK response into the right CliError, or say it is worth another
 * attempt. Shared by the buffered and streaming paths so both classify
 * auth, missing models and rate limits identically.
 */
async function classifyStatus(
  res: Response,
  ctx: PostContext,
  last: boolean,
): Promise<'ok' | 'retry'> {
  if (res.status === 401 || res.status === 403) {
    throw new CliError(`${ctx.provider}: authentication failed (HTTP ${res.status})`, {
      hint: `Your API key is missing, invalid or expired. Run "devpilot auth ${ctx.provider}" to update it.`,
    });
  }
  if (res.status === 404) {
    throw new CliError(`${ctx.provider}: model or endpoint not found (HTTP 404)`, {
      hint: `The default model may have been retired. Override it in ${'~/.devpilot/config.json'} under router.models.${ctx.provider}.`,
    });
  }
  if (RETRYABLE_STATUS.has(res.status) && !last) return 'retry';
  if (res.status === 429) {
    throw new CliError(`${ctx.provider}: rate limited (HTTP 429)`, {
      hint: 'You hit the provider rate limit. Wait a moment, or route elsewhere with --provider.',
    });
  }
  if (!res.ok) {
    throw new CliError(
      `${ctx.provider}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`,
      RETRYABLE_STATUS.has(res.status)
        ? {
            hint: `The provider failed ${MAX_ATTEMPTS} times in a row — it is probably having trouble. Try again shortly, or route elsewhere with --provider.`,
          }
        : undefined,
    );
  }
  return 'ok';
}

/**
 * POST and hand back each chunk of the answer as it arrives. Every streaming
 * provider ships the same shape — newline-delimited frames carrying a text
 * delta — so the transport is shared and only `deltaOf` differs.
 *
 * No retry here: once the first byte reaches the user's terminal, replaying
 * the call would print the answer twice. A failure before that surfaces as
 * the same CliError the buffered path produces.
 */
async function postStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: PostContext,
  deltaOf: (frame: unknown) => string,
  onDelta: (text: string) => void,
): Promise<string> {
  let res: Response;
  try {
    res = await rawPost(url, headers, body, ctx);
  } catch (err) {
    if (err instanceof TransientNetworkError) {
      throw new CliError(`${ctx.provider}: network error — ${err.message}`, {
        hint:
          ctx.provider === 'ollama'
            ? 'Is the Ollama daemon running? Start it with "ollama serve".'
            : 'Check your internet connection and try again.',
        cause: err.reason,
      });
    }
    throw err;
  }
  await classifyStatus(res, ctx, true);
  if (!res.body) throw new CliError(`${ctx.provider}: the provider sent an empty response`);

  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  const handleLine = (raw: string): void => {
    const line = raw.trim();
    // SSE frames prefix the payload with "data:"; NDJSON providers do not.
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!payload || payload === '[DONE]' || line.startsWith('event:')) return;
    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      return; // keep-alive or comment frame
    }
    const delta = deltaOf(frame);
    if (delta) {
      answer += delta;
      onDelta(delta);
    }
  };

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  }
  if (buffer.trim()) handleLine(buffer);
  return answer;
}

/** Read `choices[0].delta.content` from an OpenAI-compatible stream frame. */
function openAiDelta(frame: unknown): string {
  const choice = (frame as { choices?: { delta?: { content?: string } }[] }).choices?.[0];
  return choice?.delta?.content ?? '';
}

/**
 * The OpenAI chat-completions API is the de-facto standard: Groq, DeepSeek,
 * Mistral, xAI and OpenRouter all speak it at a different base URL. One
 * factory keeps them a data change rather than a code change.
 */
function openAiCompatible(
  spec: Omit<ProviderSpec, 'ask' | 'askStream'> & { baseUrl: string },
): ProviderSpec {
  const { baseUrl, ...rest } = spec;
  const url = `${baseUrl}/chat/completions`;
  const bodyFor = (self: ProviderSpec, prompt: string, stream: boolean): unknown => ({
    model: modelFor(self),
    temperature: 0.2,
    stream,
    messages: [{ role: 'user', content: prompt }],
  });
  return {
    ...rest,
    async ask(prompt, apiKey) {
      const data = (await post(
        url,
        { authorization: `Bearer ${apiKey}` },
        bodyFor(this, prompt, false),
        { provider: this.id },
      )) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? '';
    },
    askStream(prompt, apiKey, onDelta) {
      return postStream(
        url,
        { authorization: `Bearer ${apiKey}` },
        bodyFor(this, prompt, true),
        { provider: this.id },
        openAiDelta,
        onDelta,
      );
    },
  };
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    model: 'claude-sonnet-5',
    models: [
      { id: 'claude-opus-5', note: 'most capable — best for large codebases' },
      { id: 'claude-sonnet-5', note: 'default — balances quality and cost' },
      { id: 'claude-haiku-4-5', note: 'fastest and cheapest' },
    ],
    cost: 3,
    speed: 2,
    quality: 1,
    contextTokens: 200_000,
    needsKey: true,
    parallel: 4,
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
    askStream(prompt, apiKey, onDelta) {
      return postStream(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: modelFor(this),
          max_tokens: 16_384,
          temperature: 0.2,
          stream: true,
          messages: [{ role: 'user', content: prompt }],
        },
        { provider: this.id },
        (frame) => (frame as { delta?: { text?: string } }).delta?.text ?? '',
        onDelta,
      );
    },
  },
  {
    // Uses the locally installed Claude Code CLI — a Claude subscription
    // (Pro/Max) works with no API key at all.
    id: 'claude-code',
    name: 'Claude Code (subscription)',
    model: 'sonnet',
    // Claude Code takes tier aliases, not full model ids — it resolves each
    // to whatever the current model in that tier is.
    models: [
      { id: 'opus', note: 'most capable — best for large codebases' },
      { id: 'sonnet', note: 'default — balances quality and cost' },
      { id: 'haiku', note: 'fastest and cheapest' },
    ],
    cost: 0,
    speed: 3,
    quality: 1,
    contextTokens: 200_000,
    needsKey: false,
    binary: 'claude',
    // Each call spawns a claude process against one subscription.
    parallel: 2,
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
    models: [
      { id: 'gpt-5', note: 'default — balances quality and cost' },
      { id: 'gpt-5-mini', note: 'faster and cheaper' },
    ],
    cost: 3,
    speed: 2,
    quality: 2,
    contextTokens: 128_000,
    needsKey: true,
    parallel: 4,
    async ask(prompt, apiKey) {
      const data = (await post(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        { model: modelFor(this), messages: [{ role: 'user', content: prompt }] },
        { provider: this.id },
      )) as { choices: { message: { content: string } }[] };
      return data.choices[0]?.message.content ?? '';
    },
    askStream(prompt, apiKey, onDelta) {
      return postStream(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        { model: modelFor(this), stream: true, messages: [{ role: 'user', content: prompt }] },
        { provider: this.id },
        openAiDelta,
        onDelta,
      );
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
    parallel: 2,
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
    models: [
      { id: 'gemini-2.5-pro', note: 'most capable — best for large codebases' },
      { id: 'gemini-2.5-flash', note: 'default — fast and inexpensive' },
    ],
    cost: 1,
    speed: 1,
    quality: 3,
    contextTokens: 1_000_000,
    needsKey: true,
    parallel: 4,
    async ask(prompt, apiKey) {
      const data = (await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelFor(this)}:generateContent?key=${apiKey}`,
        {},
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } },
        { provider: this.id },
      )) as { candidates: { content: { parts: { text: string }[] } }[] };
      return data.candidates[0]?.content.parts.map((p) => p.text).join('') ?? '';
    },
    askStream(prompt, apiKey, onDelta) {
      return postStream(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelFor(this)}:streamGenerateContent?alt=sse&key=${apiKey}`,
        {},
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } },
        { provider: this.id },
        (frame) =>
          (
            frame as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
          ).candidates?.[0]?.content?.parts
            ?.map((p) => p.text ?? '')
            .join('') ?? '',
        onDelta,
      );
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
    parallel: 2,
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
  openAiCompatible({
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    cost: 2,
    speed: 3,
    quality: 2,
    contextTokens: 200_000,
    needsKey: true,
    parallel: 4,
  }),
  openAiCompatible({
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    cost: 1,
    speed: 1,
    quality: 3,
    contextTokens: 128_000,
    needsKey: true,
    parallel: 4,
  }),
  openAiCompatible({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', note: 'default — general purpose' },
      { id: 'deepseek-reasoner', note: 'slower, reasons before answering' },
    ],
    cost: 1,
    speed: 3,
    quality: 2,
    contextTokens: 64_000,
    needsKey: true,
    parallel: 4,
  }),
  openAiCompatible({
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    models: [
      { id: 'mistral-large-latest', note: 'default — most capable' },
      { id: 'mistral-small-latest', note: 'faster and cheaper' },
    ],
    cost: 2,
    speed: 2,
    quality: 3,
    contextTokens: 128_000,
    needsKey: true,
    parallel: 4,
  }),
  openAiCompatible({
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4',
    cost: 3,
    speed: 2,
    quality: 2,
    contextTokens: 256_000,
    needsKey: true,
    parallel: 4,
  }),
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
    // One local model server: concurrent requests queue behind each other.
    parallel: 1,
    async ask(prompt) {
      const data = (await post(
        'http://localhost:11434/api/generate',
        {},
        { model: modelFor(this), prompt, stream: false, options: { temperature: 0.2 } },
        { provider: this.id },
      )) as { response: string };
      return data.response;
    },
    askStream(prompt, _apiKey, onDelta) {
      // Ollama streams newline-delimited JSON rather than SSE; postStream
      // handles both because it splits on newlines either way.
      return postStream(
        'http://localhost:11434/api/generate',
        {},
        { model: modelFor(this), prompt, stream: true, options: { temperature: 0.2 } },
        { provider: this.id },
        (frame) => (frame as { response?: string }).response ?? '',
        onDelta,
      );
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
  groq: (k) => ({
    url: 'https://api.groq.com/openai/v1/models',
    headers: { authorization: `Bearer ${k}` },
  }),
  deepseek: (k) => ({
    url: 'https://api.deepseek.com/v1/models',
    headers: { authorization: `Bearer ${k}` },
  }),
  mistral: (k) => ({
    url: 'https://api.mistral.ai/v1/models',
    headers: { authorization: `Bearer ${k}` },
  }),
  xai: (k) => ({
    url: 'https://api.x.ai/v1/models',
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
