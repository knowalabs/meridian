import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { route, PROVIDERS } from '../src/providers/router.js';
import { saveConfig, loadConfig } from '../src/core/config.js';

describe('ai router', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-router-'));
    process.env.DEVPILOT_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.DEVPILOT_HOME;
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
