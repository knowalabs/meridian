import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

/** Path to the built CLI — e2e tests exercise dist/, not src/. */
export const CLI_PATH = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Sandbox {
  /** Acts as the user's home directory (HOME/USERPROFILE point here). */
  home: string;
  /** A project directory to run commands in. */
  project: string;
  cleanup(): void;
}

/** Fresh sandbox per test: fake home + empty project, all under tmpdir. */
export function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowa-e2e-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return {
    home,
    project,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Run the built CLI as a subprocess (no shell — Windows-safe) against a
 * sandboxed home. Never touches the real user profile or OS keychain.
 */
export async function runCli(
  args: string[],
  sandbox: Sandbox,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CliResult> {
  const env = {
    ...process.env,
    KNOWA_HOME: path.join(sandbox.home, '.knowa'),
    KNOWA_VAULT: 'file',
    NO_COLOR: '1',
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    APPDATA: path.join(sandbox.home, 'AppData', 'Roaming'),
    ...opts.env,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      cwd: opts.cwd ?? sandbox.project,
      env,
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}
