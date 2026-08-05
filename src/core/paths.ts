import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Global Knowa home and its standard subdirectories:
 * %APPDATA%\knowa on Windows, ~/.knowa elsewhere.
 * KNOWA_HOME overrides both (tests and CI rely on this).
 */
export function knowaHome(): string {
  if (process.env.KNOWA_HOME) return process.env.KNOWA_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'knowa');
  }
  return path.join(os.homedir(), '.knowa');
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
  const home = knowaHome();
  fs.mkdirSync(home, { recursive: true });
  for (const sub of HOME_SUBDIRS) fs.mkdirSync(path.join(home, sub), { recursive: true });
  return home;
}

export function globalConfigPath(): string {
  return path.join(knowaHome(), 'config.json');
}

/** Project-level .knowa directory rooted at cwd (or a given dir). */
export function projectDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.knowa');
}
