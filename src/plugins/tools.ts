import fs from 'node:fs';
import path from 'node:path';
import { run, runLive, versionOf, which } from '../core/exec.js';
import type { DoctorReport, ToolPlugin } from '../core/plugin.js';
import { PluginRegistry } from '../core/plugin.js';
import { log } from '../core/logger.js';

type AppPlatform = 'darwin' | 'win32' | 'linux';

export interface ToolSpec {
  id: string;
  name: string;
  /** Binary to look for on PATH. */
  bin: string;
  /** App install locations per platform that also count as installed. */
  appPaths?: Partial<Record<AppPlatform, string[]>>;
  /** Global npm package that installs the tool. */
  npmPackage?: string;
  /** Homebrew formula or cask (macOS). */
  brew?: { name: string; cask?: boolean };
  /** winget package id (Windows). */
  winget?: { id: string };
  /** Install guidance for Linux (we never run sudo on the user's behalf). */
  linuxHint?: string;
  /** Manual install URL shown when no automated path exists. */
  installUrl?: string;
  hint?: string;
}

function hasBrew(): boolean {
  return process.platform === 'darwin' && which('brew') !== null;
}

function hasWinget(): boolean {
  return process.platform === 'win32' && which('winget') !== null;
}

/** Expand %VAR% references in Windows-style paths. */
function expandEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? `%${name}%`);
}

function platformAppPaths(spec: ToolSpec): string[] {
  const paths = spec.appPaths?.[process.platform as AppPlatform] ?? [];
  return paths.map(expandEnv);
}

export function detect(spec: ToolSpec): DoctorReport {
  const version = versionOf(spec.bin);
  if (version) return { installed: true, version };
  for (const app of platformAppPaths(spec)) {
    if (fs.existsSync(app)) return { installed: true, version: 'app installed (CLI not on PATH)' };
  }
  return { installed: false, hint: spec.hint ?? installHint(spec) };
}

function installHint(spec: ToolSpec): string {
  if (spec.npmPackage) return `npm install -g ${spec.npmPackage}`;
  if (spec.brew && hasBrew())
    return `brew install ${spec.brew.cask ? '--cask ' : ''}${spec.brew.name}`;
  if (spec.winget && hasWinget()) return `winget install --id ${spec.winget.id}`;
  if (process.platform === 'linux' && spec.linuxHint) return spec.linuxHint;
  return spec.installUrl ? `see ${spec.installUrl}` : 'manual installation required';
}

const WINGET_FLAGS = ['-e', '--accept-source-agreements', '--accept-package-agreements'];

export function makePlugin(spec: ToolSpec, configure?: () => boolean): ToolPlugin {
  return {
    id: spec.id,
    name: spec.name,

    doctor: () => detect(spec),

    install(): boolean {
      if (detect(spec).installed) {
        log.ok(`${spec.name} is already installed`);
        return true;
      }
      if (spec.npmPackage) {
        log.info(`Installing ${spec.name} via npm…`);
        return runLive('npm', ['install', '-g', spec.npmPackage]);
      }
      if (spec.brew && hasBrew()) {
        log.info(`Installing ${spec.name} via Homebrew…`);
        const args = spec.brew.cask
          ? ['install', '--cask', spec.brew.name]
          : ['install', spec.brew.name];
        return runLive('brew', args);
      }
      if (spec.winget && hasWinget()) {
        log.info(`Installing ${spec.name} via winget…`);
        return runLive('winget', ['install', '--id', spec.winget.id, ...WINGET_FLAGS]);
      }
      log.warn(`${spec.name} has no automated installer on this platform: ${installHint(spec)}`);
      return false;
    },

    uninstall(): boolean {
      if (spec.npmPackage) return runLive('npm', ['uninstall', '-g', spec.npmPackage]);
      if (spec.brew && hasBrew()) {
        const args = spec.brew.cask
          ? ['uninstall', '--cask', spec.brew.name]
          : ['uninstall', spec.brew.name];
        return runLive('brew', args);
      }
      if (spec.winget && hasWinget()) {
        return runLive('winget', ['uninstall', '--id', spec.winget.id, '-e']);
      }
      log.warn(`${spec.name} must be uninstalled manually`);
      return false;
    },

    configure(): boolean {
      return configure ? configure() : true;
    },

    validate(): boolean {
      return detect(spec).installed;
    },

    update(): boolean {
      if (spec.npmPackage) return runLive('npm', ['install', '-g', `${spec.npmPackage}@latest`]);
      if (spec.brew && hasBrew()) {
        const res = run('brew', ['upgrade', spec.brew.name]);
        return res.ok || /already installed/i.test(res.stderr);
      }
      if (spec.winget && hasWinget()) {
        const res = run('winget', ['upgrade', '--id', spec.winget.id, ...WINGET_FLAGS]);
        return res.ok || /no available upgrade|no applicable update/i.test(res.stdout + res.stderr);
      }
      log.warn(`${spec.name} must be updated manually`);
      return false;
    },
  };
}

/* ------------------------------ supported tools ------------------------------ */

export const TOOL_SPECS: ToolSpec[] = [
  {
    id: 'git',
    name: 'Git',
    bin: 'git',
    brew: { name: 'git' },
    winget: { id: 'Git.Git' },
    linuxHint: 'install with your package manager, e.g. sudo apt install git',
    installUrl: 'https://git-scm.com/downloads',
  },
  {
    id: 'node',
    name: 'Node.js',
    bin: 'node',
    brew: { name: 'node' },
    winget: { id: 'OpenJS.NodeJS.LTS' },
    linuxHint: 'install via your package manager or https://nodejs.org',
    installUrl: 'https://nodejs.org',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    bin: 'code',
    appPaths: {
      darwin: ['/Applications/Visual Studio Code.app'],
      win32: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe'],
    },
    brew: { name: 'visual-studio-code', cask: true },
    winget: { id: 'Microsoft.VisualStudioCode' },
    linuxHint: 'install from https://code.visualstudio.com or your package manager',
    installUrl: 'https://code.visualstudio.com',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    bin: 'cursor',
    appPaths: {
      darwin: ['/Applications/Cursor.app'],
      win32: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'],
    },
    brew: { name: 'cursor', cask: true },
    winget: { id: 'Anysphere.Cursor' },
    linuxHint: 'download the AppImage from https://cursor.com',
    installUrl: 'https://cursor.com',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    npmPackage: '@openai/codex',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    npmPackage: '@google/gemini-cli',
  },
  {
    id: 'docker',
    name: 'Docker',
    bin: 'docker',
    appPaths: {
      darwin: ['/Applications/Docker.app'],
      win32: ['%ProgramFiles%\\Docker\\Docker\\Docker Desktop.exe'],
    },
    brew: { name: 'docker-desktop', cask: true },
    winget: { id: 'Docker.DockerDesktop' },
    linuxHint: 'see https://docs.docker.com/engine/install/',
    installUrl: 'https://docs.docker.com/get-docker/',
  },
];

export function buildRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const spec of TOOL_SPECS) registry.register(makePlugin(spec));
  return registry;
}

/**
 * AI tools this project should get an instruction file for: those installed on
 * this machine, plus any whose config the project already carries (so a repo
 * cloned onto a machine without the tool keeps the file it already had).
 *
 * The ids returned match `RULE_TARGETS` in `src/rules/generators.ts` — that
 * coupling is why this lives here, next to the detection it reuses, rather
 * than being reimplemented there.
 *
 * `copilot` has no CLI to detect, so it is reported only when the project
 * already carries its instruction file.
 */
let detectOverride: ((root: string) => string[]) | null = null;

/** Test seam: pin tool detection so a run does not depend on the host machine. */
export function setToolDetectionForTests(impl: ((root: string) => string[]) | null): void {
  detectOverride = impl;
}

export function detectedAiTools(root: string): string[] {
  if (detectOverride) return detectOverride(root);
  const has = (...rel: string[]): boolean => rel.some((r) => fs.existsSync(path.join(root, r)));
  const installed = (id: string): boolean => {
    const spec = TOOL_SPECS.find((t) => t.id === id);
    return spec ? detect(spec).installed : false;
  };
  const found: string[] = [];
  if (installed('claude') || has('CLAUDE.md', '.claude')) found.push('claude');
  if (installed('cursor') || has('.cursor')) found.push('cursor');
  if (installed('codex') || has('AGENTS.md')) found.push('codex');
  if (installed('gemini') || has('GEMINI.md')) found.push('gemini');
  if (has(path.join('.github', 'copilot-instructions.md'))) found.push('copilot');
  return found;
}
