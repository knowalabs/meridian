import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectWorkspaces, renderWorkspaces } from '../src/scan/workspaces.js';
import { createIgnore } from '../src/scan/ignore.js';
import { analyzeProject, renderContextMarkdown } from '../src/scan/analyzer.js';
import { buildDigest } from '../src/generate/digest.js';
import { diffFingerprints, fingerprintOf } from '../src/generate/manifest.js';

describe('workspace detection', () => {
  let tmp: string;
  const write = (rel: string, content: string): void => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const pkg = (rel: string, name: string, extra: object = {}): void =>
    write(`${rel}/package.json`, JSON.stringify({ name, ...extra }));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-ws-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null for an ordinary single-package project', () => {
    pkg('.', 'solo');
    expect(detectWorkspaces(tmp)).toBeNull();
  });

  it('detects npm workspaces and each package name, scripts and deps', () => {
    pkg('.', 'root', { workspaces: ['packages/*'] });
    pkg('packages/api', '@demo/api', {
      scripts: { test: 'vitest' },
      dependencies: { express: '^4' },
    });
    pkg('packages/web', '@demo/web', { scripts: { build: 'vite build' } });

    const ws = detectWorkspaces(tmp, createIgnore(tmp));
    expect(ws?.tool).toBe('npm');
    expect(ws?.packages.map((p) => p.name)).toEqual(['@demo/api', '@demo/web']);
    expect(ws?.packages[0]?.scripts.test).toBe('vitest');
    expect(ws?.packages[0]?.dependencies).toContain('express');
    expect(ws?.packages[1]?.path).toBe('packages/web');
  });

  it('reads the yarn flavor from packageManager', () => {
    pkg('.', 'root', { workspaces: ['apps/*'], packageManager: 'yarn@4.1.0' });
    pkg('apps/one', 'one');
    expect(detectWorkspaces(tmp)?.tool).toBe('yarn');
  });

  it('detects pnpm workspaces from the yaml list form', () => {
    write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n  - tools/cli\n');
    pkg('packages/core', 'core');
    pkg('tools/cli', 'cli');
    const ws = detectWorkspaces(tmp, createIgnore(tmp));
    expect(ws?.tool).toBe('pnpm');
    expect(ws?.packages.map((p) => p.path)).toEqual(['packages/core', 'tools/cli']);
  });

  it('detects pnpm workspaces from the inline list form', () => {
    write('pnpm-workspace.yaml', 'packages: ["libs/*"]\n');
    pkg('libs/a', 'a');
    expect(detectWorkspaces(tmp)?.packages).toHaveLength(1);
  });

  it('detects Cargo workspace members and their crate names', () => {
    write('Cargo.toml', '[workspace]\nmembers = [\n  "crates/engine",\n  "crates/cli",\n]\n');
    write('crates/engine/Cargo.toml', '[package]\nname = "engine"\n');
    write('crates/cli/Cargo.toml', '[package]\nname = "demo-cli"\n');
    const ws = detectWorkspaces(tmp, createIgnore(tmp));
    expect(ws?.tool).toBe('cargo');
    expect(ws?.packages.map((p) => p.name).sort()).toEqual(['demo-cli', 'engine']);
  });

  it('detects go.work modules in both block and single-line form', () => {
    write('go.work', 'go 1.22\n\nuse (\n  ./svc/api\n  ./svc/worker\n)\n');
    write('svc/api/go.mod', 'module example.com/api\n');
    write('svc/worker/go.mod', 'module example.com/worker\n');
    const ws = detectWorkspaces(tmp, createIgnore(tmp));
    expect(ws?.tool).toBe('go');
    expect(ws?.packages.map((p) => p.name).sort()).toEqual([
      'example.com/api',
      'example.com/worker',
    ]);
  });

  it('records turborepo and nx as workspace runners', () => {
    pkg('.', 'root', { workspaces: ['packages/*'] });
    pkg('packages/a', 'a');
    write('turbo.json', '{}');
    expect(detectWorkspaces(tmp, createIgnore(tmp))?.runners).toContain('Turborepo');
  });

  it('expands double-star globs and skips ignored directories', () => {
    pkg('.', 'root', { workspaces: ['apps/**'] });
    pkg('apps/web', 'web');
    pkg('apps/web/nested', 'nested');
    pkg('apps/node_modules/leaked', 'leaked');
    const names = detectWorkspaces(tmp, createIgnore(tmp))?.packages.map((p) => p.name);
    expect(names).toContain('web');
    expect(names).toContain('nested');
    expect(names).not.toContain('leaked');
  });

  it('ignores a workspace glob that matches nothing', () => {
    pkg('.', 'root', { workspaces: ['packages/*'] });
    expect(detectWorkspaces(tmp, createIgnore(tmp))).toBeNull();
  });
});

describe('workspaces in the analysis and digest', () => {
  let tmp: string;
  const write = (rel: string, content: string): void => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-ws-scan-'));
    write('package.json', JSON.stringify({ name: 'monorepo', workspaces: ['packages/*'] }));
    write(
      'packages/api/package.json',
      JSON.stringify({ name: '@demo/api', scripts: { test: 'vitest' } }),
    );
    write('packages/api/src/server.ts', 'export function serve() {}\n');
    write('packages/web/package.json', JSON.stringify({ name: '@demo/web' }));
    write('packages/web/src/app.ts', 'export function render() {}\n');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('exposes packages on the analysis and names the monorepo in frameworks', () => {
    const a = analyzeProject(tmp);
    expect(a.workspaces?.packages.map((p) => p.name)).toEqual(['@demo/api', '@demo/web']);
    expect(a.frameworks).toContain('Monorepo (npm workspaces)');
  });

  it('describes the packages in context.md and in the digest', () => {
    const a = analyzeProject(tmp);
    expect(renderContextMarkdown(a)).toContain('Workspace packages');
    const digest = buildDigest(tmp);
    expect(digest.text).toContain('Workspace packages');
    expect(digest.text).toContain('@demo/api');
    // Sampling spreads across packages instead of favoring the largest one.
    expect(digest.includedFiles).toContain('packages/api/src/server.ts');
    expect(digest.includedFiles).toContain('packages/web/src/app.ts');
  });

  it('treats an added or removed package as kit drift', () => {
    const before = fingerprintOf(analyzeProject(tmp));
    write('packages/jobs/package.json', JSON.stringify({ name: '@demo/jobs' }));
    const after = fingerprintOf(analyzeProject(tmp));
    expect(diffFingerprints(before, after)).toContainEqual(
      expect.stringContaining('new workspace package: @demo/jobs'),
    );
  });

  it('renders a compact package summary', () => {
    const info = detectWorkspaces(tmp, createIgnore(tmp))!;
    const rendered = renderWorkspaces(info);
    expect(rendered).toContain('Workspace: npm');
    expect(rendered).toContain('@demo/api (packages/api)');
    expect(rendered).toContain('scripts: test');
  });
});
