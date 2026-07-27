import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS, setFetchForTests, setRuntimeModel } from '../src/providers/router.js';
import { openVault } from '../src/core/vault.js';
import { askCommand } from '../src/commands/ask.js';
import { configureLogger } from '../src/core/logger.js';

/** A streaming HTTP response built from the frames a provider would send. */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('streaming providers', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-stream-'));
    process.env.DEVPILOT_HOME = tmp;
    process.env.DEVPILOT_VAULT = 'file';
  });
  afterEach(() => {
    setFetchForTests(null);
    setRuntimeModel(null);
    delete process.env.DEVPILOT_HOME;
    delete process.env.DEVPILOT_VAULT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('assembles an Anthropic SSE stream and reports each delta', async () => {
    const anthropic = PROVIDERS.find((p) => p.id === 'anthropic')!;
    setFetchForTests(async () =>
      sseResponse([
        'event: content_block_delta\ndata: {"delta":{"text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"delta":{"text":" world"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const seen: string[] = [];
    const answer = await anthropic.askStream!('hi', 'key', (d) => seen.push(d));
    expect(answer).toBe('Hello world');
    expect(seen).toEqual(['Hello', ' world']);
  });

  it('assembles an OpenAI-compatible stream and stops at [DONE]', async () => {
    const groq = PROVIDERS.find((p) => p.id === 'groq')!;
    setFetchForTests(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"par"}}]}\n',
        'data: {"choices":[{"delta":{"content":"tial"}}]}\n',
        'data: [DONE]\n',
      ]),
    );
    expect(await groq.askStream!('hi', 'key', () => {})).toBe('partial');
  });

  it('handles frames split across chunk boundaries', async () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai')!;
    setFetchForTests(async () =>
      sseResponse(['data: {"choices":[{"delta":{"con', 'tent":"split"}}]}\n', 'data: [DONE]\n']),
    );
    expect(await openai.askStream!('hi', 'key', () => {})).toBe('split');
  });

  it('reads Ollama newline-delimited JSON', async () => {
    const ollama = PROVIDERS.find((p) => p.id === 'ollama')!;
    setFetchForTests(async () =>
      sseResponse(['{"response":"lo"}\n{"response":"cal"}\n{"response":"","done":true}\n']),
    );
    expect(await ollama.askStream!('hi', '', () => {})).toBe('local');
  });

  it('ignores keep-alives and unparseable frames instead of failing', async () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai')!;
    setFetchForTests(async () =>
      sseResponse([
        ': keep-alive\n',
        '\n',
        'data: not json\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
      ]),
    );
    expect(await openai.askStream!('hi', 'key', () => {})).toBe('ok');
  });

  it('classifies an auth failure the same way the buffered path does', async () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai')!;
    setFetchForTests(async () => new Response('nope', { status: 401 }));
    await expect(openai.askStream!('hi', 'bad', () => {})).rejects.toThrowError(
      /authentication failed/,
    );
  });
});

describe('OpenAI-compatible providers', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-compat-'));
    process.env.DEVPILOT_HOME = tmp;
    process.env.DEVPILOT_VAULT = 'file';
  });
  afterEach(() => {
    setFetchForTests(null);
    setRuntimeModel(null);
    delete process.env.DEVPILOT_HOME;
    delete process.env.DEVPILOT_VAULT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const [id, host] of [
    ['groq', 'api.groq.com'],
    ['deepseek', 'api.deepseek.com'],
    ['mistral', 'api.mistral.ai'],
    ['xai', 'api.x.ai'],
    ['openrouter', 'openrouter.ai'],
  ] as const) {
    it(`${id} posts a chat completion to its own host and returns the message`, async () => {
      const provider = PROVIDERS.find((p) => p.id === id)!;
      let seenUrl = '';
      let seenAuth = '';
      setFetchForTests(async (url, init) => {
        seenUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        seenAuth = String((init?.headers as Record<string, string>).authorization);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      expect(await provider.ask('hi', 'sk-test')).toBe('answer');
      expect(seenUrl).toContain(host);
      expect(seenUrl).toContain('/chat/completions');
      expect(seenAuth).toBe('Bearer sk-test');
    });
  }

  it('sends the runtime model override', async () => {
    const deepseek = PROVIDERS.find((p) => p.id === 'deepseek')!;
    setRuntimeModel('deepseek', 'deepseek-reasoner');
    let sentModel = '';
    setFetchForTests(async (_url, init) => {
      sentModel = (JSON.parse(init?.body as string) as { model: string }).model;
      return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await deepseek.ask('hi', 'k');
    expect(sentModel).toBe('deepseek-reasoner');
  });
});

describe('ask command', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-askcmd-'));
    process.env.DEVPILOT_HOME = tmp;
    process.env.DEVPILOT_VAULT = 'file';
    configureLogger({ level: 'quiet' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    setFetchForTests(null);
    setRuntimeModel(null);
    configureLogger({ level: 'normal', json: false });
    vi.restoreAllMocks();
    delete process.env.DEVPILOT_HOME;
    delete process.env.DEVPILOT_VAULT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('buffers rather than streams when stdout is not a terminal', async () => {
    openVault().set('anthropic', 'k');
    let streamed = false;
    setFetchForTests(async (_url, init) => {
      if ((JSON.parse(init?.body as string) as { stream?: boolean }).stream) streamed = true;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'answer' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    expect(await askCommand(['hello'], { provider: 'anthropic' })).toBe(0);
    expect(streamed).toBe(false); // a piped answer must arrive whole
  });

  it('applies --model to the provider serving the question', async () => {
    openVault().set('anthropic', 'k');
    let sentModel = '';
    setFetchForTests(async (_url, init) => {
      sentModel = (JSON.parse(init?.body as string) as { model: string }).model;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'x' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await askCommand(['hello'], { provider: 'anthropic', model: 'claude-opus-4-8' });
    expect(sentModel).toBe('claude-opus-4-8');
  });
});
