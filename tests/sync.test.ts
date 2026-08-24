import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  diffFingerprints,
  fileStates,
  fingerprintOf,
  hashContent,
  readManifest,
  signatureOf,
} from '../src/generate/manifest.js';
import { runGenerate } from '../src/generate/pipeline.js';
import { syncCommand } from '../src/commands/sync.js';
import { analyzeProject } from '../src/scan/analyzer.js';
import { configureLogger } from '../src/core/logger.js';
import {
  modelFor,
  PROVIDERS,
  setFetchForTests,
  setRetryDelayForTests,
  setRuntimeModel,
} from '../src/providers/router.js';
import { RULE_TARGETS } from '../src/rules/generators.js';
import { setToolDetectionForTests } from '../src/plugins/tools.js';
import { authCommand } from '../src/commands/auth.js';

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-sync-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'sync-demo',
      scripts: { test: 'vitest run', lint: 'eslint src', build: 'tsc' },
    }),
  );
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/index.ts'), 'export const app = 1;\n');
  return root;
}

/** Generate the full static kit so a manifest exists to sync against. */
async function generateKit(root: string): Promise<void> {
  await runGenerate({ root, kinds: [], force: false, dryRun: false, noAi: true });
}

const addScript = (root: string, name: string, cmd: string): void => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  pkg.scripts[name] = cmd;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
};

describe('kit manifest', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is written by runGenerate with a fingerprint and per-file hashes', async () => {
    await generateKit(root);
    const manifest = readManifest(root)!;
    expect(manifest).not.toBeNull();
    expect(manifest.provider).toBeNull();
    expect(manifest.fingerprint.scripts['test']).toBe('vitest run');
    // Written artifacts and propagated tool files are both tracked.
    expect(manifest.files['.meridian/rules.md']).toBeDefined();
    expect(manifest.files['CLAUDE.md']).toBeDefined();
    const rules = fs.readFileSync(path.join(root, '.meridian/rules.md'), 'utf8');
    expect(manifest.files['.meridian/rules.md']).toBe(signatureOf(rules));
  });

  it('survives the project formatter rewriting the kit after generation', async () => {
    await generateKit(root);
    const file = path.join(root, '.meridian/rules.md');
    const original = fs.readFileSync(file, 'utf8');
    // What Prettier does to generated markdown: emphasis markers, list
    // bullets, table padding and blank lines — none of it changes the content.
    fs.writeFileSync(
      file,
      original
        .replace(/^- /gm, '* ')
        .replace(/\n\n/g, '\n\n\n')
        .replace(/\*([^*\n]+)\*/g, '_$1_'),
    );
    const states = fileStates(root, readManifest(root)!);
    expect(states.clean).toContain('.meridian/rules.md');
    expect(states.edited).not.toContain('.meridian/rules.md');
  });

  it('still sees a real edit through the formatter tolerance', async () => {
    await generateKit(root);
    const file = path.join(root, '.meridian/rules.md');
    fs.appendFileSync(file, '\n- Never touch the vendor directory.\n');
    expect(fileStates(root, readManifest(root)!).edited).toContain('.meridian/rules.md');
  });

  it('reads a legacy manifest that recorded raw content hashes', async () => {
    await generateKit(root);
    const manifest = readManifest(root)!;
    const rules = fs.readFileSync(path.join(root, '.meridian/rules.md'), 'utf8');
    // Kits generated before signatures existed stored a bare sha256.
    fs.writeFileSync(
      path.join(root, '.meridian/manifest.json'),
      JSON.stringify({ ...manifest, files: { '.meridian/rules.md': hashContent(rules) } }),
    );
    expect(fileStates(root, readManifest(root)!).clean).toContain('.meridian/rules.md');
    fs.appendFileSync(path.join(root, '.meridian/rules.md'), '\nedited\n');
    expect(fileStates(root, readManifest(root)!).edited).toContain('.meridian/rules.md');
  });

  it('is not written by a dry run', async () => {
    await runGenerate({ root, kinds: [], force: false, dryRun: true, noAi: true });
    expect(readManifest(root)).toBeNull();
  });

  it('classifies files as clean, edited or missing', async () => {
    await generateKit(root);
    fs.appendFileSync(path.join(root, '.meridian/rules.md'), '\n- my own rule\n');
    fs.rmSync(path.join(root, '.claude/commands/verify.md'));
    const states = fileStates(root, readManifest(root)!);
    expect(states.edited).toContain('.meridian/rules.md');
    expect(states.missing).toContain('.claude/commands/verify.md');
    expect(states.clean).toContain('.claude/skills/commit/SKILL.md');
  });

  it('diffs fingerprints into human-readable drift', () => {
    const a = analyzeProject(makeProjectTracked());
    const before = fingerprintOf(a);
    const after = structuredClone(before);
    after.scripts['format'] = 'prettier -w .';
    after.scripts['test'] = 'jest';
    delete after.scripts['lint'];
    after.frameworks = [...after.frameworks, 'React'];
    const drift = diffFingerprints(before, after);
    expect(drift).toContain('new script: format (prettier -w .)');
    expect(drift).toContain('changed script: test ("vitest run" → "jest")');
    expect(drift).toContain('removed script: lint');
    expect(drift).toContain('new framework: React');
    expect(diffFingerprints(before, before)).toEqual([]);
  });

  // Extra temp roots created inside a test body, cleaned in afterEach via list.
  const extraRoots: string[] = [];
  function makeProjectTracked(): string {
    const r = makeProject();
    extraRoots.push(r);
    return r;
  }
  afterEach(() => {
    for (const r of extraRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });
});

describe('syncCommand', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    configureLogger({ level: 'normal', json: false });
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails with guidance when no manifest exists', async () => {
    expect(await syncCommand({}, root)).toBe(1);
  });

  it('--check passes on a fresh kit and fails after codebase drift', async () => {
    await generateKit(root);
    expect(await syncCommand({ check: true }, root)).toBe(0);
    addScript(root, 'format', 'prettier -w .');
    expect(await syncCommand({ check: true }, root)).toBe(1);
  });

  it('--check fails when a generated file was deleted, but not when merely edited', async () => {
    await generateKit(root);
    fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\nhand edit\n');
    expect(await syncCommand({ check: true }, root)).toBe(0);
    fs.rmSync(path.join(root, '.claude/commands/verify.md'));
    expect(await syncCommand({ check: true }, root)).toBe(1);
  });

  it('refreshes stale files, regenerates deleted ones and preserves hand edits', async () => {
    await generateKit(root);
    const rulesPath = path.join(root, '.meridian/rules.md');
    const edited = fs.readFileSync(rulesPath, 'utf8') + '\n- my own rule\n';
    fs.writeFileSync(rulesPath, edited);
    fs.rmSync(path.join(root, '.claude/commands/verify.md'));
    addScript(root, 'format', 'prettier -w .');

    expect(await syncCommand({ ai: false }, root)).toBe(0);
    // Hand-edited rules survive the refresh…
    expect(fs.readFileSync(rulesPath, 'utf8')).toBe(edited);
    // …deleted files come back, and the new script surfaces in the kit.
    expect(fs.existsSync(path.join(root, '.claude/commands/verify.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude/commands/format.md'))).toBe(true);
    // The refreshed manifest represents the new codebase: check passes again.
    expect(await syncCommand({ check: true }, root)).toBe(0);
  });

  it('does nothing when the kit is already in sync', async () => {
    await generateKit(root);
    const before = fs.statSync(path.join(root, '.meridian/rules.md')).mtimeMs;
    expect(await syncCommand({ ai: false }, root)).toBe(0);
    expect(fs.statSync(path.join(root, '.meridian/rules.md')).mtimeMs).toBe(before);
  });
});

/**
 * The paths `syncCommand` takes that the happy-path tests above never reach:
 * option validation, `--json`, the rules-mirror propagation, provider
 * selection failures, and a refresh the provider could not finish.
 */
describe('syncCommand — option handling, JSON and failure paths', () => {
  let tmp: string;
  let root: string;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  /** Everything the command printed — log.fail/warn go to stderr, not stdout. */
  const output = (): string =>
    [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0])).join('\n');
  const lastJson = <T>(): T => JSON.parse(String(logSpy.mock.calls.at(-1)![0])) as T;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-synco-'));
    root = makeProject();
    process.env.MERIDIAN_HOME = path.join(tmp, 'home');
    process.env.MERIDIAN_VAULT = 'file';
    // Provider availability otherwise depends on which AI CLIs the developer
    // happens to have on PATH, which would make these assertions machine-local.
    process.env.MERIDIAN_DISABLE_PROVIDERS = PROVIDERS.map((p) => p.id).join(',');
    // Otherwise which mirrors exist depends on the AI CLIs the developer has
    // installed, and the assertions below become machine-local.
    setToolDetectionForTests(() => RULE_TARGETS.map((t) => t.id));
    setRetryDelayForTests(0);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    configureLogger({ level: 'normal', json: false });
    setToolDetectionForTests(null);
    setRetryDelayForTests(null);
    setRuntimeModel(null);
    setFetchForTests(null);
    delete process.env.MERIDIAN_HOME;
    delete process.env.MERIDIAN_VAULT;
    delete process.env.MERIDIAN_DISABLE_PROVIDERS;
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('--concurrency', () => {
    // Validated before the manifest is read, so it fails the same way in a
    // project that was never generated.
    it.each(['0', '-1', '1.5', 'abc', ''])('rejects %o', async (value) => {
      expect(await syncCommand({ concurrency: value }, root)).toBe(1);
    });

    it('accepts a positive whole number', async () => {
      await generateKit(root);
      expect(await syncCommand({ concurrency: '2', ai: false }, root)).toBe(0);
    });
  });

  it('--model overrides the model for the provider serving the refresh', async () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai')!;
    expect(modelFor(openai)).toBe(openai.model);
    // No manifest: the run stops right after the model is applied, which is
    // exactly the seam under test.
    expect(await syncCommand({ model: 'gpt-test-9', provider: 'openai' }, root)).toBe(1);
    expect(modelFor(openai)).toBe('gpt-test-9');
  });

  it('--model is a no-op when nothing would serve the refresh', async () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai')!;
    // No provider named and none available, so there is nothing to pin.
    expect(await syncCommand({ model: 'gpt-test-9' }, root)).toBe(1);
    expect(modelFor(openai)).toBe(openai.model);
  });

  describe('--json --check', () => {
    it('reports a fresh kit as in sync and exits 0', async () => {
      await generateKit(root);
      configureLogger({ json: true });
      expect(await syncCommand({ check: true }, root)).toBe(0);
      const doc = lastJson<{ inSync: boolean; drift: string[]; staleMirrors: string[] }>();
      expect(doc.inSync).toBe(true);
      expect(doc.drift).toEqual([]);
      expect(doc.staleMirrors).toEqual([]);
    });

    it('reports drift and exits 1', async () => {
      await generateKit(root);
      addScript(root, 'format', 'prettier -w .');
      configureLogger({ json: true });
      expect(await syncCommand({ check: true }, root)).toBe(1);
      const doc = lastJson<{ inSync: boolean; drift: string[] }>();
      expect(doc.inSync).toBe(false);
      expect(doc.drift.length).toBeGreaterThan(0);
    });

    it('reports stale mirrors separately from codebase drift', async () => {
      await generateKit(root);
      fs.appendFileSync(path.join(root, '.meridian/rules.md'), '\n- my own rule\n');
      configureLogger({ json: true });
      expect(await syncCommand({ check: true }, root)).toBe(1);
      const doc = lastJson<{ inSync: boolean; drift: string[]; staleMirrors: string[] }>();
      expect(doc.inSync).toBe(false);
      // The codebase has not moved — only the rules file has.
      expect(doc.drift).toEqual([]);
      expect(doc.staleMirrors).toContain('CLAUDE.md');
    });
  });

  describe('rules propagation', () => {
    const rulesPath = (): string => path.join(root, '.meridian/rules.md');

    it('--check fails when the mirrors no longer match an edited rules file', async () => {
      await generateKit(root);
      fs.appendFileSync(rulesPath(), '\n- my own rule\n');
      expect(await syncCommand({ check: true }, root)).toBe(1);
      expect(output()).toContain('no longer match .meridian/rules.md');
      // --check never writes: the mirrors are still stale afterwards.
      expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).not.toContain('my own rule');
    });

    it('propagates the edit into every mirror and leaves the rules file alone', async () => {
      await generateKit(root);
      const edited = fs.readFileSync(rulesPath(), 'utf8') + '\n- my own rule\n';
      fs.writeFileSync(rulesPath(), edited);

      expect(await syncCommand({ ai: false }, root)).toBe(0);

      expect(fs.readFileSync(rulesPath(), 'utf8')).toBe(edited);
      for (const target of RULE_TARGETS) {
        expect(fs.readFileSync(path.join(root, target.file), 'utf8')).toContain('my own rule');
      }
      expect(await syncCommand({ check: true }, root)).toBe(0);
    });

    it('leaves a hand-edited mirror alone — that case is overwritten on generate', async () => {
      await generateKit(root);
      fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\nhand edit\n');
      // The canonical file is untouched, so this is not propagation's business.
      expect(await syncCommand({ check: true }, root)).toBe(0);
      expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('hand edit');
    });
  });

  it('regenerates a deleted rules file and re-mirrors it to every tool', async () => {
    await generateKit(root);
    fs.rmSync(path.join(root, '.meridian/rules.md'));
    for (const target of RULE_TARGETS) fs.rmSync(path.join(root, target.file));

    expect(await syncCommand({ ai: false }, root)).toBe(0);

    expect(fs.existsSync(path.join(root, '.meridian/rules.md'))).toBe(true);
    for (const target of RULE_TARGETS) {
      expect(fs.existsSync(path.join(root, target.file)), target.file).toBe(true);
    }
    expect(output()).toContain('rules propagated');
  });

  describe('no usable provider', () => {
    it('names the provider the user asked for', async () => {
      await generateKit(root);
      addScript(root, 'format', 'prettier -w .');
      expect(await syncCommand({ provider: 'openai' }, root)).toBe(1);
      expect(output()).toContain('meridian auth openai');
    });

    it('points at the offline path when none is configured', async () => {
      await generateKit(root);
      addScript(root, 'format', 'prettier -w .');
      expect(await syncCommand({}, root)).toBe(1);
      expect(output()).toContain('meridian sync --no-ai');
    });
  });

  it('--dry-run plans a refresh without writing', async () => {
    await generateKit(root);
    fs.rmSync(path.join(root, '.claude/commands/verify.md'));
    expect(await syncCommand({ dryRun: true, ai: false }, root)).toBe(0);
    expect(output()).toContain('dry run');
    expect(fs.existsSync(path.join(root, '.claude/commands/verify.md'))).toBe(false);
  });

  it('--json reports the refresh result', async () => {
    await generateKit(root);
    addScript(root, 'format', 'prettier -w .');
    configureLogger({ json: true });
    expect(await syncCommand({ ai: false }, root)).toBe(0);
    const doc = lastJson<{ drift: string[]; clean: string[]; result: { files: unknown[] } }>();
    expect(doc.drift.length).toBeGreaterThan(0);
    expect(doc.result.files.length).toBeGreaterThan(0);
  });

  describe('a refresh the provider could not finish', () => {
    /** Make one keyed provider usable, then decide what its HTTP calls do. */
    async function withProvider(respond: () => Promise<Response>): Promise<void> {
      delete process.env.MERIDIAN_DISABLE_PROVIDERS;
      process.env.MERIDIAN_DISABLE_PROVIDERS = PROVIDERS.filter((p) => p.id !== 'openai')
        .map((p) => p.id)
        .join(',');
      await authCommand('openai', 'sk-unit-test', { verify: false });
      setFetchForTests(respond);
    }

    it('reports which kinds are still missing and exits 1', async () => {
      await generateKit(root);
      addScript(root, 'format', 'prettier -w .');
      await withProvider(async () => new Response('server exploded', { status: 500 }));

      expect(await syncCommand({}, root)).toBe(1);
      expect(output()).toContain('Not refreshed yet');
    });

    it('--json reports the failure and exits 1', async () => {
      await generateKit(root);
      addScript(root, 'format', 'prettier -w .');
      await withProvider(async () => new Response('server exploded', { status: 500 }));
      configureLogger({ json: true });

      expect(await syncCommand({}, root)).toBe(1);
      expect(lastJson<{ result: { failed: string[] } }>().result.failed.length).toBeGreaterThan(0);
    });

    it('says the provider hit a limit when it did', async () => {
      await generateKit(root);
      addScript(root, 'format', 'prettier -w .');
      await withProvider(async () => new Response('quota exhausted', { status: 429 }));

      expect(await syncCommand({}, root)).toBe(1);
      expect(output()).toContain('hit a limit');
    });
  });
});
