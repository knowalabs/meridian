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
    expect(searchMcp('browser').map((s) => s.id)).toEqual(expect.arrayContaining(['puppeteer', 'playwright']));
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
    const touched = addServer(spec, project);
    const mcpJson = path.join(project, '.mcp.json');
    expect(touched).toContain(mcpJson);
    const config = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
    expect(config.mcpServers.github.command).toBe('npx');
    expect(config.mcpServers.github.env).toHaveProperty('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(listInstalled()).toContain('github');
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
