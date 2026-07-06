import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// addServer/removeServer write into tool configs under the user's home
// directory — point homedir at the test sandbox so tests never touch
// real ~/.cursor or ~/.gemini configs.
let mockHome = '';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => mockHome || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const { getMcp, searchMcp, MCP_REGISTRY } = await import('../src/mcp/registry.js');
const { addServer, listInstalled, removeServer } = await import('../src/mcp/configure.js');

describe('mcp registry', () => {
  it('searches by id, name and description', () => {
    expect(searchMcp('github').map((s) => s.id)).toContain('github');
    expect(searchMcp('browser').map((s) => s.id)).toEqual(
      expect.arrayContaining(['puppeteer', 'playwright']),
    );
    expect(searchMcp('zzz-nothing')).toHaveLength(0);
  });

  it('has unique ids', () => {
    const ids = MCP_REGISTRY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('mcp configure', () => {
  let tmp: string;
  let project: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-mcp-'));
    project = path.join(tmp, 'project');
    fs.mkdirSync(project, { recursive: true });
    process.env.DEVPILOT_HOME = path.join(tmp, 'home');
    mockHome = path.join(tmp, 'userhome');
    fs.mkdirSync(mockHome, { recursive: true });
  });

  afterEach(() => {
    delete process.env.DEVPILOT_HOME;
    mockHome = '';
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the server into project .mcp.json and tracks it', () => {
    const spec = getMcp('github')!;
    const report = addServer(spec, project);
    const mcpJson = path.join(project, '.mcp.json');
    expect(report.touched).toContain(mcpJson);
    expect(report.skipped).toEqual([]);
    const config = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
    expect(config.mcpServers.github.command).toBe('npx');
    expect(config.mcpServers.github.env).toHaveProperty('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(listInstalled()).toContain('github');
  });

  it('writes env-var references, never the resolved secret values', () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'ghp_super_secret_token';
    try {
      addServer(getMcp('github')!, project);
      const raw = fs.readFileSync(path.join(project, '.mcp.json'), 'utf8');
      expect(raw).not.toContain('ghp_super_secret_token');
      const config = JSON.parse(raw);
      expect(config.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
        '${GITHUB_PERSONAL_ACCESS_TOKEN}',
      );
    } finally {
      delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    }
  });

  it('refuses to overwrite a malformed tool config and backs it up', () => {
    const cursorDir = path.join(mockHome, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const cursorConfig = path.join(cursorDir, 'mcp.json');
    fs.writeFileSync(cursorConfig, '{broken json!!');

    const report = addServer(getMcp('memory')!, project);

    // The malformed config is untouched, reported, and backed up.
    expect(fs.readFileSync(cursorConfig, 'utf8')).toBe('{broken json!!');
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.file).toBe(cursorConfig);
    expect(report.skipped[0]!.backup).toBeDefined();
    expect(fs.readFileSync(report.skipped[0]!.backup!, 'utf8')).toBe('{broken json!!');
    // The healthy project config was still written.
    expect(report.touched).toContain(path.join(project, '.mcp.json'));
  });

  it('refuses to merge into a config with an unexpected mcpServers shape', () => {
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: 'oops' }));
    const report = addServer(getMcp('memory')!, project);
    expect(report.touched).toEqual([]);
    expect(report.skipped[0]!.reason).toContain('unexpected shape');
    expect(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: 'oops',
    });
  });

  it('preserves unrelated keys in shared settings files', () => {
    const geminiDir = path.join(mockHome, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const settings = path.join(geminiDir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', telemetry: { enabled: false } }));
    addServer(getMcp('memory')!, project);
    const config = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(config.theme).toBe('dark');
    expect(config.telemetry).toEqual({ enabled: false });
    expect(config.mcpServers.memory).toBeDefined();
  });

  it('preserves existing servers when adding and removing', () => {
    fs.writeFileSync(
      path.join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { custom: { command: 'x', args: [] } } }),
    );
    addServer(getMcp('memory')!, project);
    let config = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'));
    expect(Object.keys(config.mcpServers).sort()).toEqual(['custom', 'memory']);

    removeServer('memory', project);
    config = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'));
    expect(Object.keys(config.mcpServers)).toEqual(['custom']);
    expect(listInstalled()).not.toContain('memory');
  });
});
