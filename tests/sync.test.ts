import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-sync-'));
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
    expect(manifest.files['.devpilot/rules.md']).toBeDefined();
    expect(manifest.files['CLAUDE.md']).toBeDefined();
    const rules = fs.readFileSync(path.join(root, '.devpilot/rules.md'), 'utf8');
    expect(manifest.files['.devpilot/rules.md']).toBe(signatureOf(rules));
  });

  it('survives the project formatter rewriting the kit after generation', async () => {
    await generateKit(root);
    const file = path.join(root, '.devpilot/rules.md');
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
    expect(states.clean).toContain('.devpilot/rules.md');
    expect(states.edited).not.toContain('.devpilot/rules.md');
  });

  it('still sees a real edit through the formatter tolerance', async () => {
    await generateKit(root);
    const file = path.join(root, '.devpilot/rules.md');
    fs.appendFileSync(file, '\n- Never touch the vendor directory.\n');
    expect(fileStates(root, readManifest(root)!).edited).toContain('.devpilot/rules.md');
  });

  it('reads a legacy manifest that recorded raw content hashes', async () => {
    await generateKit(root);
    const manifest = readManifest(root)!;
    const rules = fs.readFileSync(path.join(root, '.devpilot/rules.md'), 'utf8');
    // Kits generated before signatures existed stored a bare sha256.
    fs.writeFileSync(
      path.join(root, '.devpilot/manifest.json'),
      JSON.stringify({ ...manifest, files: { '.devpilot/rules.md': hashContent(rules) } }),
    );
    expect(fileStates(root, readManifest(root)!).clean).toContain('.devpilot/rules.md');
    fs.appendFileSync(path.join(root, '.devpilot/rules.md'), '\nedited\n');
    expect(fileStates(root, readManifest(root)!).edited).toContain('.devpilot/rules.md');
  });

  it('is not written by a dry run', async () => {
    await runGenerate({ root, kinds: [], force: false, dryRun: true, noAi: true });
    expect(readManifest(root)).toBeNull();
  });

  it('classifies files as clean, edited or missing', async () => {
    await generateKit(root);
    fs.appendFileSync(path.join(root, '.devpilot/rules.md'), '\n- my own rule\n');
    fs.rmSync(path.join(root, '.claude/commands/verify.md'));
    const states = fileStates(root, readManifest(root)!);
    expect(states.edited).toContain('.devpilot/rules.md');
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
    const rulesPath = path.join(root, '.devpilot/rules.md');
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
    const before = fs.statSync(path.join(root, '.devpilot/rules.md')).mtimeMs;
    expect(await syncCommand({ ai: false }, root)).toBe(0);
    expect(fs.statSync(path.join(root, '.devpilot/rules.md')).mtimeMs).toBe(before);
  });
});
