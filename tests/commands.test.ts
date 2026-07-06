import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureLogger } from '../src/core/logger.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { authCommand, keysListCommand, keysRemoveCommand, keysRepairCommand } from '../src/commands/auth.js';
import { mcpInstallCommand, mcpListCommand, mcpRemoveCommand, mcpSearchCommand } from '../src/commands/mcp.js';
import { initCommand } from '../src/commands/init.js';
import { scanCommand } from '../src/commands/scan.js';
import { rulesGenerateCommand, rulesListCommand } from '../src/commands/rules.js';
import { routerConfigCommand } from '../src/commands/ask.js';
import { buildCli } from '../src/cli.js';
import { loadConfig } from '../src/core/config.js';

let tmp: string;
let project: string;
let logSpy: ReturnType<typeof vi.spyOn>;

/** stdout captured since the last reset. */
function stdout(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
}
function lastJson<T>(): T {
  // log.json emits the whole document as a single console.log call.
  return JSON.parse(String(logSpy.mock.calls.at(-1)![0])) as T;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-cmd-'));
  project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  process.env.DEVPILOT_HOME = path.join(tmp, 'home');
  process.env.DEVPILOT_VAULT = 'file';
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  configureLogger({ level: 'normal', json: false });
  delete process.env.DEVPILOT_HOME;
  delete process.env.DEVPILOT_VAULT;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('doctor command', () => {
  it('reports every supported tool and exits 0', () => {
    configureLogger({ json: true });
    expect(doctorCommand()).toBe(0);
    const doc = lastJson<{ tools: { id: string }[]; missing: number }>();
    expect(doc.tools.length).toBeGreaterThanOrEqual(8);
    expect(doc.missing).toBeGreaterThanOrEqual(0);
  });
});

describe('auth / keys commands', () => {
  it('stores, lists, removes a key and updates the provider cache', async () => {
    expect(await authCommand('openai', 'sk-unit-test')).toBe(0);
    expect(loadConfig().providers).toContain('openai');

    configureLogger({ json: true });
    expect(keysListCommand()).toBe(0);
    const doc = lastJson<{ keys: { provider: string; masked: string }[] }>();
    expect(doc.keys[0]!.provider).toBe('openai');
    expect(doc.keys[0]!.masked).not.toContain('unit-test');
    configureLogger({ json: false });

    expect(keysRemoveCommand('openai')).toBe(0);
    expect(loadConfig().providers).not.toContain('openai');
    expect(keysRemoveCommand('openai')).toBe(1); // already gone
  });

  it('rejects unknown providers', async () => {
    expect(await authCommand('not-a-provider', 'key')).toBe(1);
  });

  it('repair on an empty vault is a no-op success', () => {
    expect(keysRepairCommand()).toBe(0);
  });
});

describe('mcp commands', () => {
  it('search returns results (json) and 1 on no matches', () => {
    configureLogger({ json: true });
    expect(mcpSearchCommand('github')).toBe(0);
    expect(lastJson<{ results: { id: string }[] }>().results.map((r) => r.id)).toContain('github');
    expect(mcpSearchCommand('zzz-no-such-server')).toBe(1);
  });

  it('install → list → remove round-trip in a sandbox project', () => {
    expect(mcpInstallCommand('memory', project)).toBe(0);
    configureLogger({ json: true });
    expect(mcpListCommand()).toBe(0);
    expect(lastJson<{ installed: { id: string }[] }>().installed.map((s) => s.id)).toContain('memory');
    configureLogger({ json: false });
    expect(mcpRemoveCommand('memory', project)).toBe(0);
    expect(mcpRemoveCommand('memory', project)).toBe(1); // nowhere configured now
  });

  it('unknown server id exits 1', () => {
    expect(mcpInstallCommand('nope', project)).toBe(1);
  });
});

describe('init / scan / rules commands', () => {
  it('init + scan + rules generate work together in a project', () => {
    fs.writeFileSync(path.join(project, 'main.ts'), 'export const a = 1;\n');
    expect(initCommand(project)).toBe(0);

    configureLogger({ json: true });
    expect(scanCommand(project)).toBe(0);
    const doc = lastJson<{ totalFiles: number; files: { context: string } }>();
    expect(doc.totalFiles).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(project, doc.files.context))).toBe(true);
    configureLogger({ json: false });

    expect(rulesGenerateCommand([], project)).toBe(0);
    expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(true);
    expect(rulesGenerateCommand(['bogus-target'], project)).toBe(1);
    expect(rulesListCommand()).toBe(0);
  });
});

describe('router config command', () => {
  it('validates and persists preferences', () => {
    expect(routerConfigCommand({ prefer: 'anthropic', optimize: 'cost' })).toBe(0);
    const config = loadConfig();
    expect(config.router.prefer).toBe('anthropic');
    expect(config.router.optimize).toBe('cost');
    expect(routerConfigCommand({ prefer: 'not-a-provider' })).toBe(1);
    expect(routerConfigCommand({ optimize: 'vibes' })).toBe(1);
  });
});

describe('cli wiring', () => {
  it('builds the full command tree with global flags on leaves', () => {
    const program = buildCli({ exitOverride: true });
    const names = program.commands.map((c) => c.name());
    for (const expected of ['doctor', 'install', 'auth', 'keys', 'init', 'scan', 'rules', 'mcp', 'ask', 'router', 'update', 'login']) {
      expect(names).toContain(expected);
    }
    const doctor = program.commands.find((c) => c.name() === 'doctor')!;
    const flags = doctor.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--verbose', '--quiet', '--json', '--no-color']));
  });

  it('runs a command end-to-end through commander', async () => {
    const program = buildCli({ exitOverride: true });
    await program.parseAsync(['rules', 'list'], { from: 'user' });
    expect(stdout()).toContain('claude');
  });
});
