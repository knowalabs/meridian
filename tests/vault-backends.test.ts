import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecResult } from '../src/core/exec.js';

const runMock = vi.fn<(cmd: string, args?: string[], input?: string) => ExecResult>();
const whichMock = vi.fn<(bin: string) => string | null>();
vi.mock('../src/core/exec.js', () => ({
  run: (cmd: string, args?: string[], input?: string) => runMock(cmd, args, input),
  which: (bin: string) => whichMock(bin),
  runLive: vi.fn(),
  versionOf: vi.fn(),
}));

const { openVault } = await import('../src/core/vault.js');

const okResult = (stdout = ''): ExecResult => ({ ok: true, stdout, stderr: '', code: 0 });

const realPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

describe('vault backend selection', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-vaultsel-'));
    process.env.KNOWA_HOME = tmp;
    delete process.env.KNOWA_VAULT;
    runMock.mockReset().mockReturnValue(okResult());
    whichMock.mockReset().mockReturnValue('/usr/bin/found');
  });

  afterEach(() => {
    setPlatform(realPlatform);
    delete process.env.KNOWA_HOME;
    delete process.env.KNOWA_VAULT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('KNOWA_VAULT=file forces the plain encrypted file vault', () => {
    process.env.KNOWA_VAULT = 'file';
    setPlatform('darwin');
    expect(openVault().backend).toBe('encrypted-file');
  });

  it('darwin with security → keychain', () => {
    setPlatform('darwin');
    expect(openVault().backend).toBe('keychain');
  });

  it('linux with secret-tool → secret-service', () => {
    setPlatform('linux');
    expect(openVault().backend).toBe('secret-service');
  });

  it('linux without secret-tool falls back to the file vault', () => {
    setPlatform('linux');
    whichMock.mockReturnValue(null);
    expect(openVault().backend).toBe('encrypted-file');
  });

  it('win32 with powershell → dpapi-file', () => {
    setPlatform('win32');
    expect(openVault().backend).toBe('dpapi-file');
  });

  it('win32 without powershell falls back to the file vault', () => {
    setPlatform('win32');
    whichMock.mockReturnValue(null);
    expect(openVault().backend).toBe('encrypted-file');
  });
});

describe('keychain vault (mocked security CLI)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-vaultkc-'));
    process.env.KNOWA_HOME = tmp;
    delete process.env.KNOWA_VAULT;
    setPlatform('darwin');
    runMock.mockReset().mockReturnValue(okResult());
    whichMock.mockReset().mockReturnValue('/usr/bin/security');
  });

  afterEach(() => {
    setPlatform(realPlatform);
    delete process.env.KNOWA_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes the secret via stdin (security -i), never argv', () => {
    openVault().set('anthropic', 'sk-ant-secret');
    const call = runMock.mock.calls.find(([cmd]) => cmd === 'security');
    expect(call).toBeDefined();
    const [, args, input] = call!;
    expect(args).toEqual(['-i']);
    expect(input).toContain('sk-ant-secret');
    // No fallback argv write should have happened since stdin succeeded.
    const argvWrites = runMock.mock.calls.filter(([, a]) => a?.includes('add-generic-password'));
    expect(argvWrites).toHaveLength(0);
  });

  it('falls back to argv when security -i is unavailable', () => {
    runMock.mockImplementation((_cmd, args) =>
      args?.[0] === '-i' ? { ok: false, stdout: '', stderr: 'bad option', code: 1 } : okResult(),
    );
    openVault().set('anthropic', 'sk-ant-secret');
    const argvWrite = runMock.mock.calls.find(([, a]) => a?.includes('add-generic-password'));
    expect(argvWrite).toBeDefined();
  });
});

describe('secret-tool vault (mocked)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-vaultst-'));
    process.env.KNOWA_HOME = tmp;
    delete process.env.KNOWA_VAULT;
    setPlatform('linux');
    runMock.mockReset().mockReturnValue(okResult());
    whichMock.mockReset().mockReturnValue('/usr/bin/secret-tool');
  });

  afterEach(() => {
    setPlatform(realPlatform);
    delete process.env.KNOWA_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stores via stdin and looks up via service/account attributes', () => {
    const vault = openVault();
    vault.set('openai', 'sk-linux-secret');
    const store = runMock.mock.calls.find(([, a]) => a?.[0] === 'store');
    expect(store).toBeDefined();
    expect(store![1]).not.toContain('sk-linux-secret'); // not in argv
    expect(store![2]).toBe('sk-linux-secret'); // via stdin

    runMock.mockReturnValue(okResult('sk-linux-secret'));
    expect(vault.get('openai')).toBe('sk-linux-secret');
    expect(vault.list()).toEqual(['openai']); // index survives
  });
});
