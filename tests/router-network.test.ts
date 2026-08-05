import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROVIDERS,
  modelFor,
  setFetchForTests,
  setRunForTests,
  verifyApiKey,
} from '../src/providers/router.js';
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-router-net-'));
    process.env.KNOWA_HOME = tmp;
  });

  afterEach(() => {
    setFetchForTests(null);
    delete process.env.KNOWA_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('returns the answer on success', async () => {
    setFetchForTests(async () =>
      jsonResponse(200, { content: [{ type: 'text', text: 'hello there' }] }),
    );
    await expect(anthropic.ask('hi', 'key')).resolves.toBe('hello there');
  });

  it('maps 401 to a CliError hinting at knowa auth', async () => {
    setFetchForTests(async () => jsonResponse(401, { error: 'bad key' }));
    const err = await anthropic.ask('hi', 'bad').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('authentication failed');
    expect((err as CliError).hint).toContain('knowa auth anthropic');
  });

  it('retries on 429, then succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    setFetchForTests(async () => {
      calls++;
      return calls === 1
        ? jsonResponse(429, { error: 'slow down' })
        : jsonResponse(200, { content: [{ type: 'text', text: 'after retry' }] });
    });
    const promise = anthropic.ask('hi', 'key');
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(promise).resolves.toBe('after retry');
    expect(calls).toBe(2);
  });

  it('gives up after the last 429 with a rate-limit CliError', async () => {
    vi.useFakeTimers();
    let calls = 0;
    setFetchForTests(async () => {
      calls++;
      return jsonResponse(429, { error: 'still slow' });
    });
    const promise = anthropic.ask('hi', 'key').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await promise;
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('rate limited');
    expect(calls).toBe(3);
  });

  it('retries a transient 502 and succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    setFetchForTests(async () => {
      calls++;
      return calls < 3
        ? jsonResponse(502, { error: 'bad gateway' })
        : jsonResponse(200, { content: [{ type: 'text', text: 'recovered' }] });
    });
    const promise = anthropic.ask('hi', 'key');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe('recovered');
    expect(calls).toBe(3);
  });

  it('surfaces a persistent 5xx with a "provider is having trouble" hint', async () => {
    vi.useFakeTimers();
    setFetchForTests(async () => new Response('upstream exploded', { status: 503 }));
    const promise = anthropic.ask('hi', 'key').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await promise;
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('HTTP 503');
    expect((err as CliError).hint).toContain('3 times in a row');
  });

  it('waits the Retry-After interval when the provider sends one', async () => {
    vi.useFakeTimers();
    let calls = 0;
    setFetchForTests(async () => {
      calls++;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '5' } })
        : jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] });
    });
    const promise = anthropic.ask('hi', 'key');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(1); // still waiting out the 5s the provider asked for
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(promise).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries a dropped connection before giving up', async () => {
    vi.useFakeTimers();
    let calls = 0;
    setFetchForTests(async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return jsonResponse(200, { content: [{ type: 'text', text: 'reconnected' }] });
    });
    const promise = anthropic.ask('hi', 'key');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe('reconnected');
    expect(calls).toBe(2);
  });

  it('does not retry a request the provider rejected as invalid', async () => {
    let calls = 0;
    setFetchForTests(async () => {
      calls++;
      return jsonResponse(400, { error: 'bad request' });
    });
    await expect(anthropic.ask('hi', 'key')).rejects.toThrowError(/HTTP 400/);
    expect(calls).toBe(1);
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

  it('maps persistent connection failures to a connectivity hint (Ollama daemon)', async () => {
    vi.useFakeTimers();
    setFetchForTests(async () => {
      throw new TypeError('fetch failed');
    });
    const promise = ollama.ask('hi', '').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await promise;
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
      sentModel = (JSON.parse(init?.body as string) as { model: string }).model;
      return jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] });
    });
    await anthropic.ask('hi', 'key');
    expect(sentModel).toBe('claude-opus-4-8');
  });
});

describe('claude-code CLI provider', () => {
  const claudeCode = PROVIDERS.find((p) => p.id === 'claude-code')!;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-cc-'));
    process.env.KNOWA_HOME = tmp;
  });
  afterEach(() => {
    setRunForTests(null);
    delete process.env.KNOWA_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('pipes the prompt via stdin and returns stdout', async () => {
    let seen: { cmd: string; args: string[]; input?: string } | null = null;
    setRunForTests((cmd, args = [], input) => {
      seen = { cmd, args, input };
      return { ok: true, stdout: 'generated answer', stderr: '', code: 0 };
    });
    await expect(claudeCode.ask('big prompt', '')).resolves.toBe('generated answer');
    expect(seen!.cmd).toBe('claude');
    expect(seen!.args).toContain('-p');
    expect(seen!.input).toBe('big prompt'); // stdin, not argv — survives huge digests
  });

  it('honors a model override from config', async () => {
    const config = loadConfig();
    config.router.models = { 'claude-code': 'opus' };
    saveConfig(config);
    let args: string[] = [];
    setRunForTests((_c, a = []) => {
      args = a;
      return { ok: true, stdout: 'x', stderr: '', code: 0 };
    });
    await claudeCode.ask('hi', '');
    expect(args).toContain('opus');
  });

  it('maps missing binary and CLI failure to actionable CliErrors', async () => {
    setRunForTests(() => ({
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      error: 'spawn claude ENOENT',
      notFound: true,
    }));
    await expect(claudeCode.ask('hi', '')).rejects.toThrowError(/not installed/);

    setRunForTests(() => ({
      ok: false,
      stdout: '',
      stderr: 'Invalid API key. Please run /login',
      code: 1,
    }));
    await expect(claudeCode.ask('hi', '')).rejects.toThrowError(/claude -p failed/);
  });
});

describe('codex-cli and gemini-cli providers', () => {
  const codex = PROVIDERS.find((p) => p.id === 'codex-cli')!;
  const gemini = PROVIDERS.find((p) => p.id === 'gemini-cli')!;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-cli-prov-'));
    process.env.KNOWA_HOME = tmp;
  });
  afterEach(() => {
    setRunForTests(null);
    delete process.env.KNOWA_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('codex pipes stdin, prefers the last-message file, falls back to stdout', async () => {
    let seen: { cmd: string; args: string[]; input?: string } | null = null;
    setRunForTests((cmd, args = [], input) => {
      seen = { cmd, args, input };
      // Simulate codex writing the clean last message to the -o file.
      const outFile = args[args.indexOf('-o') + 1]!;
      fs.writeFileSync(outFile, 'clean final answer\n');
      return { ok: true, stdout: 'noisy progress logs', stderr: '', code: 0 };
    });
    await expect(codex.ask('prompt', '')).resolves.toBe('clean final answer');
    expect(seen!.cmd).toBe('codex');
    expect(seen!.args.slice(0, 2)).toEqual(['exec', '-']);
    expect(seen!.args).toContain('--skip-git-repo-check');
    expect(seen!.input).toBe('prompt');

    // Without the file, stdout is the answer.
    setRunForTests(() => ({ ok: true, stdout: 'stdout answer', stderr: '', code: 0 }));
    await expect(codex.ask('prompt', '')).resolves.toBe('stdout answer');
  });

  it('codex omits -m by default and maps failure to a sign-in hint', async () => {
    let args: string[] = [];
    setRunForTests((_c, a = []) => {
      args = a;
      return { ok: true, stdout: 'x', stderr: '', code: 0 };
    });
    await codex.ask('hi', '');
    expect(args).not.toContain('-m');

    setRunForTests(() => ({ ok: false, stdout: '', stderr: 'Not logged in', code: 1 }));
    await expect(codex.ask('hi', '')).rejects.toThrowError(/codex exec failed/);
  });

  it('gemini pipes stdin and returns stdout', async () => {
    let input: string | undefined;
    setRunForTests((_c, _a, i) => {
      input = i;
      return { ok: true, stdout: 'gemini answer', stderr: '', code: 0 };
    });
    await expect(gemini.ask('ask this', '')).resolves.toBe('gemini answer');
    expect(input).toBe('ask this');

    setRunForTests(() => ({
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      error: 'spawn gemini ENOENT',
      notFound: true,
    }));
    await expect(gemini.ask('hi', '')).rejects.toThrowError(/not installed/);
  });
});

describe('verifyApiKey', () => {
  afterEach(() => setFetchForTests(null));

  it('accepts on 2xx and on 429 (key reached the account)', async () => {
    setFetchForTests(async () => new Response('{}', { status: 200 }));
    expect(await verifyApiKey('openai', 'sk-good')).toBe('valid');
    setFetchForTests(async () => new Response('slow down', { status: 429 }));
    expect(await verifyApiKey('anthropic', 'sk-busy')).toBe('valid');
  });

  it('rejects on 401/403, and 400 for google', async () => {
    setFetchForTests(async () => new Response('nope', { status: 401 }));
    expect(await verifyApiKey('openai', 'sk-bad')).toBe('invalid');
    setFetchForTests(async () => new Response('API_KEY_INVALID', { status: 400 }));
    expect(await verifyApiKey('google', 'bad')).toBe('invalid');
  });

  it('reports unreachable on network errors and 5xx', async () => {
    setFetchForTests(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await verifyApiKey('openrouter', 'k')).toBe('unreachable');
    setFetchForTests(async () => new Response('boom', { status: 500 }));
    expect(await verifyApiKey('openai', 'k')).toBe('unreachable');
  });

  it('passes through providers it has no checker for', async () => {
    expect(await verifyApiKey('some-future-provider', 'k')).toBe('valid');
  });
});
