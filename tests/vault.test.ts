import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVault } from '../src/core/vault.js';

describe('encrypted file vault', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-vault-'));
    process.env.DEVPILOT_HOME = tmp;
    process.env.DEVPILOT_VAULT = 'file';
  });

  afterEach(() => {
    delete process.env.DEVPILOT_HOME;
    delete process.env.DEVPILOT_VAULT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stores and retrieves secrets', () => {
    const vault = openVault();
    vault.set('anthropic', 'sk-ant-test-123');
    expect(vault.get('anthropic')).toBe('sk-ant-test-123');
  });

  it('never writes secrets in plaintext', () => {
    const vault = openVault();
    vault.set('openai', 'sk-super-secret-value');
    const files = fs.readdirSync(path.join(tmp, 'keys'));
    for (const f of files) {
      const content = fs.readFileSync(path.join(tmp, 'keys', f), 'utf8');
      expect(content).not.toContain('sk-super-secret-value');
    }
  });

  it('lists and deletes secrets', () => {
    const vault = openVault();
    vault.set('openai', 'a');
    vault.set('google', 'b');
    expect(vault.list()).toEqual(['google', 'openai']);
    expect(vault.delete('openai')).toBe(true);
    expect(vault.list()).toEqual(['google']);
    expect(vault.get('openai')).toBeNull();
    expect(vault.delete('missing')).toBe(false);
  });

  it('overwrites an existing secret', () => {
    const vault = openVault();
    vault.set('openai', 'old');
    vault.set('openai', 'new');
    expect(vault.get('openai')).toBe('new');
    expect(vault.list()).toEqual(['openai']);
  });
});
