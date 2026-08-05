import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hasModelChoice,
  modelFor,
  modelsFor,
  PROVIDERS,
  route,
  saveModelChoice,
  setRunForTests,
  type ProviderSpec,
} from '../src/providers/router.js';
import { saveConfig, loadConfig } from '../src/core/config.js';

describe('ai router', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-router-'));
    process.env.KNOWA_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.KNOWA_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when no providers are available', () => {
    expect(route('hello', [])).toBeNull();
  });

  it('honors an explicit user preference', () => {
    const config = loadConfig();
    config.router.prefer = 'openai';
    saveConfig(config);
    const decision = route('hello', ['anthropic', 'openai']);
    expect(decision?.provider.id).toBe('openai');
    expect(decision?.reason).toContain('preference');
  });

  it('optimizes for cost when configured', () => {
    const config = loadConfig();
    config.router.optimize = 'cost';
    saveConfig(config);
    const decision = route('hello', ['anthropic', 'google']);
    expect(decision?.provider.id).toBe('google'); // cheaper
  });

  it('defaults to the highest-quality provider', () => {
    const decision = route('hello', ['anthropic', 'google', 'openrouter']);
    expect(decision?.provider.id).toBe('anthropic');
  });

  it('excludes providers whose context window is too small', () => {
    const huge = 'x'.repeat(600_000); // ~150k tokens: exceeds openai's 128k window
    const decision = route(huge, ['openai', 'google']);
    expect(decision?.provider.id).toBe('google');
  });

  it('registry lists every supported provider', () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual([
      'anthropic',
      'claude-code',
      'codex-cli',
      'deepseek',
      'gemini-cli',
      'google',
      'groq',
      'mistral',
      'ollama',
      'openai',
      'openrouter',
      'xai',
    ]);
  });

  it('gives every provider the fields the router and pipeline read', () => {
    for (const p of PROVIDERS) {
      expect(typeof p.name).toBe('string');
      expect(p.model.length).toBeGreaterThan(0);
      expect(p.contextTokens).toBeGreaterThan(0);
      expect(typeof p.ask).toBe('function');
      // A keyless provider must name the binary that proves it is usable.
      if (!p.needsKey) expect(p.binary).toBeTruthy();
    }
  });

  it('prefers the Claude Code CLI when optimizing for cost', () => {
    const config = loadConfig();
    config.router.optimize = 'cost';
    saveConfig(config);
    const decision = route('hello', ['anthropic', 'claude-code', 'ollama']);
    expect(decision?.provider.id).toBe('claude-code'); // subscription: no per-token cost
  });

  it('prefers the anthropic API over the CLI on quality ties', () => {
    const decision = route('hello', ['anthropic', 'claude-code']);
    expect(decision?.provider.id).toBe('anthropic');
  });
});

describe('model catalogue', () => {
  let tmp: string;
  const spec = (id: string): ProviderSpec => PROVIDERS.find((p) => p.id === id)!;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-models-'));
    process.env.KNOWA_HOME = tmp;
  });
  afterEach(() => {
    setRunForTests(null);
    delete process.env.KNOWA_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('only offers model ids the provider would accept', () => {
    for (const provider of PROVIDERS) {
      for (const model of provider.models ?? []) {
        expect(model.id.trim(), provider.id).toBe(model.id);
        expect(model.id).not.toMatch(/\s/);
        expect(model.note, `${provider.id}/${model.id}`).toBeTruthy();
      }
      // A shipped catalogue that omits the provider's own default would offer
      // no way back to it.
      if (provider.models)
        expect(
          provider.models.map((m) => m.id),
          provider.id,
        ).toContain(provider.model);
    }
  });

  it('puts the model in play first, so Enter keeps it', async () => {
    const models = await modelsFor(spec('anthropic'));
    expect(models[0]?.id).toBe('claude-sonnet-5'); // the provider default
    expect(models.map((m) => m.id)).toContain('claude-opus-5');
  });

  it('keeps a configured model selectable even when it predates the catalogue', async () => {
    saveModelChoice('anthropic', 'claude-from-the-future');
    const models = await modelsFor(spec('anthropic'));
    expect(models[0]).toEqual({ id: 'claude-from-the-future', note: 'in use' });
    // …and it appears exactly once, not twice.
    expect(models.filter((m) => m.id === 'claude-from-the-future')).toHaveLength(1);
  });

  it('discovers Ollama models from the machine instead of shipping a list', async () => {
    expect(spec('ollama').models).toBeUndefined();
    setRunForTests(() => ({
      ok: true,
      code: 0,
      stderr: '',
      stdout: 'NAME    ID    SIZE\nqwen3:8b   abc   5 GB\ndevstral:latest   def   14 GB\n',
    }));
    const ids = (await modelsFor(spec('ollama'))).map((m) => m.id);
    expect(ids).toContain('qwen3:8b');
    expect(ids).toContain('devstral:latest');
    expect(ids).not.toContain('NAME');
  });

  it('falls back to the configured model when Ollama is not answering', async () => {
    setRunForTests(() => {
      throw new Error('spawn ollama ENOENT');
    });
    expect((await modelsFor(spec('ollama'))).map((m) => m.id)).toEqual(['llama3.2']);
  });

  it('records a choice, reports it, and clears back to the default', () => {
    expect(hasModelChoice('anthropic')).toBe(false);
    saveModelChoice('anthropic', 'claude-opus-5');
    expect(hasModelChoice('anthropic')).toBe(true);
    expect(modelFor(spec('anthropic'))).toBe('claude-opus-5');
    saveModelChoice('anthropic', '');
    expect(hasModelChoice('anthropic')).toBe(false);
    expect(modelFor(spec('anthropic'))).toBe('claude-sonnet-5');
  });
});
