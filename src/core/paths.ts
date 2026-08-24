import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Global Meridian home and its standard subdirectories:
 * %APPDATA%\meridian on Windows, ~/.meridian elsewhere.
 * MERIDIAN_HOME overrides both (tests and CI rely on this).
 */
export function meridianHome(): string {
  if (process.env.MERIDIAN_HOME) return process.env.MERIDIAN_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'meridian');
  }
  return path.join(os.homedir(), '.meridian');
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
  const home = meridianHome();
  fs.mkdirSync(home, { recursive: true });
  for (const sub of HOME_SUBDIRS) fs.mkdirSync(path.join(home, sub), { recursive: true });
  return home;
}

export function globalConfigPath(): string {
  return path.join(meridianHome(), 'config.json');
}

/** Project-level .meridian directory rooted at cwd (or a given dir). */
export function projectDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.meridian');
}
