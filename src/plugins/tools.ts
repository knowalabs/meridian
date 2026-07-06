import fs from 'node:fs';
import { run, runLive, versionOf, which } from '../core/exec.js';
import type { DoctorReport, ToolPlugin } from '../core/plugin.js';
import { PluginRegistry } from '../core/plugin.js';
import { log } from '../core/logger.js';

export interface ToolSpec {
  id: string;
  name: string;
  /** Binary to look for on PATH. */
  bin: string;
  /** macOS .app bundle paths that also count as installed. */
  appPaths?: string[];
  /** Global npm package that installs the tool. */
  npmPackage?: string;
  /** Homebrew formula or cask (macOS). */
  brew?: { name: string; cask?: boolean };
  /** Manual install URL shown when no automated path exists. */
  installUrl?: string;
  hint?: string;
}

function hasBrew(): boolean {
  return process.platform === 'darwin' && which('brew') !== null;
}

export function detect(spec: ToolSpec): DoctorReport {
  const version = versionOf(spec.bin);
  if (version) return { installed: true, version };
  for (const app of spec.appPaths ?? []) {
    if (fs.existsSync(app)) return { installed: true, version: 'app installed (CLI not on PATH)' };
  }
  return { installed: false, hint: spec.hint ?? installHint(spec) };
}

function installHint(spec: ToolSpec): string {
  if (spec.npmPackage) return `npm install -g ${spec.npmPackage}`;
  if (spec.brew && hasBrew()) return `brew install ${spec.brew.cask ? '--cask ' : ''}${spec.brew.name}`;
  return spec.installUrl ? `see ${spec.installUrl}` : 'manual installation required';
}

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
    installUrl: 'https://git-scm.com/downloads',
  },
  {
    id: 'node',
    name: 'Node.js',
    bin: 'node',
    brew: { name: 'node' },
    installUrl: 'https://nodejs.org',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    bin: 'code',
    appPaths: ['/Applications/Visual Studio Code.app'],
    brew: { name: 'visual-studio-code', cask: true },
    installUrl: 'https://code.visualstudio.com',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    bin: 'cursor',
    appPaths: ['/Applications/Cursor.app'],
    brew: { name: 'cursor', cask: true },
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
    appPaths: ['/Applications/Docker.app'],
    brew: { name: 'docker-desktop', cask: true },
    installUrl: 'https://docs.docker.com/get-docker/',
  },
];

export function buildRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const spec of TOOL_SPECS) registry.register(makePlugin(spec));
  return registry;
}
