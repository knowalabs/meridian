import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Global DevPilot home and its standard subdirectories:
 * %APPDATA%\devpilot on Windows, ~/.devpilot elsewhere.
 * DEVPILOT_HOME overrides both (tests and CI rely on this).
 */
export function devpilotHome(): string {
  if (process.env.DEVPILOT_HOME) return process.env.DEVPILOT_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'devpilot');
  }
  return path.join(os.homedir(), '.devpilot');
}

export const HOME_SUBDIRS = [
  'keys',
  'providers',
  'mcp',
  'logs',
  'cache',
  'rules',
  'prompts',
  'plugins',
] as const;

export function ensureHome(): string {
  const home = devpilotHome();
  fs.mkdirSync(home, { recursive: true });
  for (const sub of HOME_SUBDIRS) fs.mkdirSync(path.join(home, sub), { recursive: true });
  return home;
}

export function globalConfigPath(): string {
  return path.join(devpilotHome(), 'config.json');
}

/** Project-level .devpilot directory rooted at cwd (or a given dir). */
export function projectDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.devpilot');
}
