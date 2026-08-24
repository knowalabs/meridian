import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const runLiveMock = vi.fn<(cmd: string, args?: string[]) => boolean>();
const whichMock = vi.fn<(bin: string) => string | null>();
const versionOfMock = vi.fn<(bin: string) => string | null>();
vi.mock('../src/core/exec.js', () => ({
  run: vi.fn(() => ({ ok: true, stdout: '', stderr: '', code: 0 })),
  runLive: (cmd: string, args?: string[]) => runLiveMock(cmd, args),
  which: (bin: string) => whichMock(bin),
  versionOf: (bin: string) => versionOfMock(bin),
}));

const { meridianHome } = await import('../src/core/paths.js');
const { makePlugin, TOOL_SPECS } = await import('../src/plugins/tools.js');
const { mcpConfigTargets } = await import('../src/mcp/configure.js');

const realPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

afterEach(() => {
  setPlatform(realPlatform);
});

describe('meridianHome per platform', () => {
  const savedAppData = process.env.APPDATA;

  beforeEach(() => {
    delete process.env.MERIDIAN_HOME;
  });

  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
  });

  it('MERIDIAN_HOME wins everywhere', () => {
    process.env.MERIDIAN_HOME = '/custom/home';
    setPlatform('win32');
    expect(meridianHome()).toBe('/custom/home');
    delete process.env.MERIDIAN_HOME;
  });

  it('uses %APPDATA%\\meridian on Windows', () => {
    setPlatform('win32');
    process.env.APPDATA = path.join('C:', 'Users', 'test', 'AppData', 'Roaming');
    expect(meridianHome()).toBe(path.join(process.env.APPDATA, 'meridian'));
  });

  it('uses ~/.meridian elsewhere', () => {
    setPlatform('linux');
    expect(meridianHome()).toBe(path.join(os.homedir(), '.meridian'));
  });
});

describe('tool installs per platform', () => {
  const gitSpec = TOOL_SPECS.find((s) => s.id === 'git')!;

  beforeEach(() => {
    runLiveMock.mockReset().mockReturnValue(true);
    versionOfMock.mockReset().mockReturnValue(null); // tool not installed
    whichMock.mockReset();
  });

  it('installs via winget on Windows', () => {
    setPlatform('win32');
    whichMock.mockImplementation((bin) => (bin === 'winget' ? 'C:\\winget.exe' : null));
    expect(makePlugin(gitSpec).install()).toBe(true);
    const [cmd, args] = runLiveMock.mock.calls[0]!;
    expect(cmd).toBe('winget');
    expect(args).toContain('Git.Git');
    expect(args).toContain('--accept-package-agreements');
  });

  it('installs via brew on macOS', () => {
    setPlatform('darwin');
    whichMock.mockImplementation((bin) => (bin === 'brew' ? '/opt/homebrew/bin/brew' : null));
    expect(makePlugin(gitSpec).install()).toBe(true);
    expect(runLiveMock.mock.calls[0]![0]).toBe('brew');
  });

  it('gives guidance instead of sudo on Linux', () => {
    setPlatform('linux');
    whichMock.mockReturnValue(null);
    expect(makePlugin(gitSpec).install()).toBe(false);
    expect(runLiveMock).not.toHaveBeenCalled(); // never runs a package manager itself
  });

  it('every non-npm tool has winget id and linux guidance', () => {
    for (const spec of TOOL_SPECS.filter((s) => !s.npmPackage)) {
      expect(spec.winget, `${spec.id} needs a winget id`).toBeDefined();
      expect(spec.linuxHint, `${spec.id} needs a linuxHint`).toBeDefined();
    }
  });
});

describe('mcp config targets per platform', () => {
  it('includes Claude Desktop at the right per-OS location', () => {
    setPlatform('darwin');
    let files = mcpConfigTargets('/proj').map((t) => t.file);
    expect(
      files.some((f) => f.includes(path.join('Library', 'Application Support', 'Claude'))),
    ).toBe(true);

    setPlatform('linux');
    files = mcpConfigTargets('/proj').map((t) => t.file);
    expect(files.some((f) => f.includes(path.join('.config', 'Claude')))).toBe(true);
  });

  it('always includes the project .mcp.json first', () => {
    expect(mcpConfigTargets('/proj')[0]!.file).toBe(path.join('/proj', '.mcp.json'));
  });
});
