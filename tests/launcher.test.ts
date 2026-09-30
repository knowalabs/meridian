import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommandLine, tokenize } from '../src/launcher.js';
import { PROVIDERS, modelFor } from '../src/providers/router.js';

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('install claude')).toEqual(['install', 'claude']);
  });

  it('keeps double-quoted strings together', () => {
    expect(tokenize('ask "what is this repo"')).toEqual(['ask', 'what is this repo']);
  });

  it('keeps single-quoted strings together', () => {
    expect(tokenize("ask 'hello world' -p openai")).toEqual(['ask', 'hello world', '-p', 'openai']);
  });

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('runCommandLine', () => {
  const cwd = process.cwd();
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-launcher-'));
    process.env.MERIDIAN_HOME = path.join(tmp, 'home');
    process.chdir(tmp);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    delete process.env.MERIDIAN_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not carry one command's --model into the next", async () => {
    const anthropic = PROVIDERS.find((p) => p.id === 'anthropic')!;
    // sync applies --model before it finds there is no kit here, then exits 1.
    expect(await runCommandLine('sync -p anthropic -m leaked-model')).toBe(1);
    expect(modelFor(anthropic)).toBe(anthropic.model);
  });
});
