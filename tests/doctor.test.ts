import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureLogger } from '../src/core/logger.js';
import { doctorCommand, type DoctorReportJson } from '../src/commands/doctor.js';
import { setFetchForTests } from '../src/providers/router.js';
import { openVault } from '../src/core/vault.js';
import { runGenerate } from '../src/generate/pipeline.js';

let tmp: string;
let project: string;
let logSpy: ReturnType<typeof vi.spyOn>;

/** The report `--json` printed, parsed. */
function report(): DoctorReportJson {
  return JSON.parse(String(logSpy.mock.calls.at(-1)![0])) as DoctorReportJson;
}

async function runDoctor(opts: { online?: boolean } = {}): Promise<DoctorReportJson> {
  configureLogger({ json: true });
  expect(await doctorCommand(opts, project)).toBe(0);
  return report();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-doctor-'));
  project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }),
  );
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src/index.ts'), 'export const app = 1;\n');
  process.env.DEVPILOT_HOME = path.join(tmp, 'home');
  // buildCli() calls ensureHome() before any command runs; mirror that here.
  fs.mkdirSync(process.env.DEVPILOT_HOME, { recursive: true });
  process.env.DEVPILOT_VAULT = 'file';
  // Without this the suite would consult whichever AI CLIs the developer
  // happens to have signed in to, making provider assertions machine-specific.
  process.env.DEVPILOT_DISABLE_PROVIDERS = 'claude-code,codex-cli,gemini-cli,ollama';
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  configureLogger({ level: 'normal', json: false });
  setFetchForTests(null);
  delete process.env.DEVPILOT_HOME;
  delete process.env.DEVPILOT_VAULT;
  delete process.env.DEVPILOT_DISABLE_PROVIDERS;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('doctor: environment', () => {
  it('reports the running node and a writable DevPilot home', async () => {
    const doc = await runDoctor();
    const node = doc.environment.find((c) => c.label === 'Node.js')!;
    expect(node.level).toBe('ok');
    expect(node.detail).toContain(process.versions.node);
    expect(doc.environment.find((c) => c.label === 'DevPilot home')?.level).toBe('ok');
  });

  it('treats a missing config as fine and a corrupt one as a warning', async () => {
    expect((await runDoctor()).environment.find((c) => c.label === 'Config')?.level).toBe('ok');
    fs.writeFileSync(path.join(process.env.DEVPILOT_HOME!, 'config.json'), '{ not json');
    const corrupt = (await runDoctor()).environment.find((c) => c.label === 'Config')!;
    expect(corrupt.level).toBe('warn');
    expect(corrupt.fix).toContain('config.json');
  });
});

describe('doctor: providers', () => {
  it('says why each provider is unusable and reports no default route', async () => {
    const doc = await runDoctor();
    expect(doc.routesTo).toBeNull();
    expect(doc.providers.every((p) => !p.ready)).toBe(true);
    const anthropic = doc.providers.find((p) => p.id === 'anthropic')!;
    expect(anthropic.blockedBy).toBe('no API key stored');
    const claudeCode = doc.providers.find((p) => p.id === 'claude-code')!;
    expect(claudeCode.blockedBy).toBeTruthy();
  });

  it('marks a provider ready once its key is stored, and names the default route', async () => {
    openVault().set('anthropic', 'sk-test');
    const doc = await runDoctor();
    const anthropic = doc.providers.find((p) => p.id === 'anthropic')!;
    expect(anthropic.ready).toBe(true);
    expect(anthropic.blockedBy).toBeNull();
    expect(anthropic.model).toBe('claude-sonnet-5');
    expect(doc.routesTo).toBe('anthropic');
  });

  it('does not touch the network unless --online is passed', async () => {
    openVault().set('anthropic', 'sk-test');
    setFetchForTests(() => {
      throw new Error('doctor must be offline by default');
    });
    const doc = await runDoctor();
    expect(doc.providers.every((p) => p.keyCheck === undefined)).toBe(true);
  });

  it('--online reports a rejected key against the provider', async () => {
    openVault().set('anthropic', 'sk-expired');
    setFetchForTests(async () => new Response('nope', { status: 401 }));
    const doc = await runDoctor({ online: true });
    expect(doc.providers.find((p) => p.id === 'anthropic')?.keyCheck).toBe('invalid');
  });

  it('--online reports an accepted key and an unreachable provider', async () => {
    openVault().set('anthropic', 'sk-good');
    setFetchForTests(async () => new Response('{}', { status: 200 }));
    expect(
      (await runDoctor({ online: true })).providers.find((p) => p.id === 'anthropic')?.keyCheck,
    ).toBe('valid');

    setFetchForTests(async () => {
      throw new TypeError('fetch failed');
    });
    expect(
      (await runDoctor({ online: true })).providers.find((p) => p.id === 'anthropic')?.keyCheck,
    ).toBe('unreachable');
  });
});

describe('doctor: vault', () => {
  it('names the backend and lists stored accounts', async () => {
    openVault().set('anthropic', 'sk-a');
    openVault().set('openai', 'sk-b');
    const doc = await runDoctor();
    expect(doc.vault.backend).toBeTruthy();
    expect(doc.vault.keys.sort()).toEqual(['anthropic', 'openai']);
    expect(doc.vault.unreadable).toEqual([]);
  });
});

describe('doctor: project kit', () => {
  it('reports no kit in a bare project', async () => {
    const doc = await runDoctor();
    expect(doc.kit.present).toBe(false);
    expect(doc.kit.root).toBe(project);
  });

  it('reports a fresh kit as in sync, then as stale once the code moves on', async () => {
    await runGenerate({ root: project, kinds: [], force: true, dryRun: false, noAi: true });

    const fresh = await runDoctor();
    expect(fresh.kit.present).toBe(true);
    expect(fresh.kit.generatedBy).toBeTruthy();
    expect(fresh.kit.drift).toEqual([]);
    expect(fresh.kit.missing).toEqual([]);

    // A new script is exactly the kind of change the kit describes.
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', lint: 'eslint src' } }),
    );
    const stale = await runDoctor();
    expect(stale.kit.drift.join(' ')).toContain('lint');
  });

  it('reports a deleted generated file as missing', async () => {
    await runGenerate({ root: project, kinds: ['rules'], force: true, dryRun: false, noAi: true });
    fs.rmSync(path.join(project, '.devpilot/rules.md'));
    expect((await runDoctor()).kit.missing).toContain('.devpilot/rules.md');
  });

  it('reports a hand-edited generated file as preserved, not as drift', async () => {
    await runGenerate({ root: project, kinds: ['rules'], force: true, dryRun: false, noAi: true });
    fs.writeFileSync(path.join(project, '.devpilot/rules.md'), '# my own rules\n');
    const doc = await runDoctor();
    expect(doc.kit.edited).toContain('.devpilot/rules.md');
    expect(doc.kit.missing).toEqual([]);
  });
});

describe('doctor: human output', () => {
  it('prints every section and ends with actionable next steps', async () => {
    configureLogger({ level: 'normal', json: false });
    expect(await doctorCommand({}, project)).toBe(0);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    for (const section of ['Environment', 'AI tools', 'AI providers', 'Key vault', 'Project kit']) {
      expect(out).toContain(section);
    }
    expect(out).toContain('Next steps');
    expect(out).toContain('devpilot generate');
  });
});
