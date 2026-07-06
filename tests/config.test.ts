import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../src/core/config.js';

describe('config corruption handling', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-config-'));
    process.env.DEVPILOT_HOME = tmp;
  });

  afterEach(() => {
    delete process.env.DEVPILOT_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips a saved config', () => {
    const config = loadConfig();
    config.router.prefer = 'anthropic';
    config.providers = ['anthropic'];
    saveConfig(config);
    expect(loadConfig()).toMatchObject({ router: { prefer: 'anthropic' }, providers: ['anthropic'] });
  });

  it('backs up a malformed config instead of silently discarding it', () => {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(file, '{corrupt!!');
    const config = loadConfig();
    expect(config.router.optimize).toBe('quality'); // defaults
    const backups = fs.readdirSync(tmp).filter((f) => f.startsWith('config.json.bak-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmp, backups[0]!), 'utf8')).toBe('{corrupt!!');
  });

  it('drops mistyped fields but keeps valid ones', () => {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        telemetry: 'yes-please', // wrong type — dropped
        router: { optimize: 'warp-speed', prefer: 'openai' }, // bad enum dropped, prefer kept
        providers: ['openai', 42, 'google'], // non-strings dropped
      }),
    );
    const config = loadConfig();
    expect(config.telemetry).toBe(false);
    expect(config.router.optimize).toBe('quality');
    expect(config.router.prefer).toBe('openai');
    expect(config.providers).toEqual(['openai', 'google']);
  });

  it('applies router model overrides when well-formed', () => {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ router: { models: { anthropic: 'claude-opus-4-8', bad: 7 } } }),
    );
    expect(loadConfig().router.models).toEqual({ anthropic: 'claude-opus-4-8' });
  });
});
