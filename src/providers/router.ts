import { loadConfig } from '../core/config.js';
import { openVault } from '../core/vault.js';
import { which } from '../core/exec.js';

/**
 * AI Router (Phase 4): route a prompt to the most suitable provider based on
 * cost, speed, context size and user preference.
 */

export interface ProviderSpec {
  id: string;
  name: string;
  model: string;
  /** Relative ranking used by the router (1 = best in class). */
  cost: number; // lower = cheaper
  speed: number; // lower = faster
  quality: number; // lower = smarter
  contextTokens: number;
  needsKey: boolean;
  ask(prompt: string, apiKey: string): Promise<string>;
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
        { model: this.model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] },
      )) as { content: { type: string; text?: string }[] };
      return data.content.map((b) => b.text ?? '').join('');
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    model: 'gpt-4o',
    cost: 3,
    speed: 2,
    quality: 2,
    contextTokens: 128_000,
    needsKey: true,
    async ask(prompt, apiKey) {
      const data = (await post(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        { model: this.model, messages: [{ role: 'user', content: prompt }] },
      )) as { choices: { message: { content: string } }[] };
      return data.choices[0]?.message.content ?? '';
    },
  },
  {
    id: 'google',
    name: 'Google Gemini',
    model: 'gemini-2.0-flash',
    cost: 1,
    speed: 1,
    quality: 3,
    contextTokens: 1_000_000,
    needsKey: true,
    async ask(prompt, apiKey) {
      const data = (await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`,
        {},
        { contents: [{ parts: [{ text: prompt }] }] },
      )) as { candidates: { content: { parts: { text: string }[] } }[] };
      return data.candidates[0]?.content.parts.map((p) => p.text).join('') ?? '';
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
        { model: this.model, messages: [{ role: 'user', content: prompt }] },
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
    async ask(prompt) {
      const data = (await post('http://localhost:11434/api/generate', {}, {
        model: this.model,
        prompt,
        stream: false,
      })) as { response: string };
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

/** Providers usable right now (key in vault, or local daemon). */
export function availableProviders(): string[] {
  const vault = openVault();
  const keys = vault.list();
  const ids = PROVIDERS.filter((p) => !p.needsKey || keys.includes(p.id)).map((p) => p.id);
  // Ollama only counts if the binary exists.
  return ids.filter((id) => id !== 'ollama' || which('ollama') !== null);
}
