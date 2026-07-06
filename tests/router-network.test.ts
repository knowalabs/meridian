import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS, modelFor, setFetchForTests } from '../src/providers/router.js';
import { CliError } from '../src/core/errors.js';
import { saveConfig, loadConfig } from '../src/core/config.js';

const anthropic = PROVIDERS.find((p) => p.id === 'anthropic')!;
const ollama = PROVIDERS.find((p) => p.id === 'ollama')!;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('provider network behavior', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-router-net-'));
    process.env.DEVPILOT_HOME = tmp;
  });

  afterEach(() => {
    setFetchForTests(null);
    delete process.env.DEVPILOT_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('returns the answer on success', async () => {
    setFetchForTests(async () =>
      jsonResponse(200, { content: [{ type: 'text', text: 'hello there' }] }),
    );
    await expect(anthropic.ask('hi', 'key')).resolves.toBe('hello there');
  });

  it('maps 401 to a CliError hinting at devpilot auth', async () => {
    setFetchForTests(async () => jsonResponse(401, { error: 'bad key' }));
    const err = await anthropic.ask('hi', 'bad').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('authentication failed');
    expect((err as CliError).hint).toContain('devpilot auth anthropic');
  });

  it('retries once on 429, then succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    setFetchForTests(async () => {
      calls++;
      return calls === 1
        ? jsonResponse(429, { error: 'slow down' })
        : jsonResponse(200, { content: [{ type: 'text', text: 'after retry' }] });
    });
    const promise = anthropic.ask('hi', 'key');
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(promise).resolves.toBe('after retry');
    expect(calls).toBe(2);
  });

  it('gives up after a second 429 with a rate-limit CliError', async () => {
    vi.useFakeTimers();
    setFetchForTests(async () => jsonResponse(429, { error: 'still slow' }));
    const promise = anthropic.ask('hi', 'key').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_500);
    const err = await promise;
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('rate limited');
  });

  it('times out a hung request via AbortController', async () => {
    vi.useFakeTimers();
    setFetchForTests(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const promise = anthropic.ask('hi', 'key').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(61_000);
    const err = await promise;
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('timed out');
  });

  it('maps connection failures to a connectivity hint (Ollama daemon)', async () => {
    setFetchForTests(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await ollama.ask('hi', '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).hint).toContain('Ollama daemon');
  });

  it('honors model overrides from config', () => {
    expect(modelFor(anthropic)).toBe('claude-sonnet-5');
    const config = loadConfig();
    config.router.models = { anthropic: 'claude-opus-4-8' };
    saveConfig(config);
    expect(modelFor(anthropic)).toBe('claude-opus-4-8');
  });

  it('sends the overridden model in the request body', async () => {
    const config = loadConfig();
    config.router.models = { anthropic: 'claude-opus-4-8' };
    saveConfig(config);
    let sentModel = '';
    setFetchForTests(async (_url, init) => {
      sentModel = (JSON.parse(String(init?.body)) as { model: string }).model;
      return jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] });
    });
    await anthropic.ask('hi', 'key');
    expect(sentModel).toBe('claude-opus-4-8');
  });
});
