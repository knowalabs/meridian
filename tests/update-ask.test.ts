import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runLiveMock = vi.fn<(cmd: string, args?: string[]) => boolean>();
vi.mock('../src/core/exec.js', () => ({
  run: vi.fn(() => ({ ok: true, stdout: '', stderr: '', code: 0 })),
  runAsync: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
  runLive: (cmd: string, args?: string[]) => runLiveMock(cmd, args),
  which: vi.fn(() => null),
  versionOf: vi.fn(() => null),
}));

const { updateCommand, loginCommand } = await import('../src/commands/update.js');
const { askCommand } = await import('../src/commands/ask.js');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-upd-'));
  process.env.DEVPILOT_HOME = tmp;
  process.env.DEVPILOT_VAULT = 'file';
  runLiveMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.DEVPILOT_HOME;
  delete process.env.DEVPILOT_VAULT;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('update command exit codes', () => {
  it('returns 0 when the self-update succeeds', async () => {
    runLiveMock.mockReturnValue(true);
    expect(await updateCommand({ self: true })).toBe(0);
    const [cmd, args] = runLiveMock.mock.calls[0]!;
    expect(cmd).toBe('npm');
    expect(args!.join(' ')).toContain('devpilot@latest');
  });

  it('returns 1 when the self-update fails (was: silent success)', async () => {
    runLiveMock.mockReturnValue(false);
    expect(await updateCommand({ self: true })).toBe(1);
  });

  it('login stub exits 0', () => {
    expect(loginCommand()).toBe(0);
  });
});

describe('ask command without providers', () => {
  it('exits 1 with guidance when no provider is configured', async () => {
    // No keys in the vault and which() is mocked to null → no Ollama either.
    expect(await askCommand(['hello'], {})).toBe(1);
  });

  it('rejects an unavailable forced provider', async () => {
    expect(await askCommand(['hello'], { provider: 'anthropic' })).toBe(1);
  });

  it('requires a prompt', async () => {
    expect(await askCommand([], {})).toBe(1);
  });
});
