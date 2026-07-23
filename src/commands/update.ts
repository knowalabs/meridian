import pc from 'picocolors';
import { runLive } from '../core/exec.js';
import { updateToolsCommand } from './install.js';
import { log } from '../core/logger.js';
import { PACKAGE_NAME } from '../core/pkg.js';

/** `devpilot update` — update the CLI itself, then installed tools. */
export async function updateCommand(opts: { self?: boolean; tools?: boolean }): Promise<number> {
  const doSelf = opts.self || (!opts.self && !opts.tools);
  const doTools = opts.tools || (!opts.self && !opts.tools);
  let failed = false;

  if (doSelf) {
    log.info('Updating DevPilot CLI…');
    if (runLive('npm', ['install', '-g', `${PACKAGE_NAME}@latest`]))
      log.ok('DevPilot is up to date');
    else {
      failed = true;
      log.fail(
        `Self-update failed — try ${pc.bold(`npm install -g ${PACKAGE_NAME}@latest`)} manually`,
      );
    }
  }
  if (doTools) {
    log.info('\nUpdating installed AI tools…');
    if ((await updateToolsCommand()) !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

/** `devpilot login` — Cloud Sync (roadmap v0.4). */
export function loginCommand(): number {
  log.warn('Cloud Sync ships in v0.4 (roadmap).');
  log.info(
    `It will sync encrypted API keys, rules, prompts, MCP config and preferences across machines.
Everything works locally today: ${pc.bold('devpilot auth')}, ${pc.bold('devpilot generate')}, ${pc.bold('devpilot mcp install')}.`,
  );
  return 0;
}
