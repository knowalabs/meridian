import pc from 'picocolors';
import { runLive } from '../core/exec.js';
import { updateToolsCommand } from './install.js';
import { log } from '../core/logger.js';
import { PACKAGE_NAME } from '../core/pkg.js';

/** `meridian update` — update the CLI itself, then installed tools. */
export async function updateCommand(opts: { self?: boolean; tools?: boolean }): Promise<number> {
  const doSelf = opts.self || (!opts.self && !opts.tools);
  const doTools = opts.tools || (!opts.self && !opts.tools);
  let failed = false;

  if (doSelf) {
    log.info('Updating Meridian CLI…');
    if (runLive('npm', ['install', '-g', `${PACKAGE_NAME}@latest`]))
      log.ok('Meridian is up to date');
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

/** `meridian login` — Cloud Sync (roadmap v0.4). */
export function loginCommand(): number {
  log.warn('Cloud Sync is not available yet — it is on the roadmap, without a date.');
  log.info(
    `It would sync encrypted API keys, rules, prompts, MCP config and preferences across machines.
Everything works locally today: ${pc.bold('meridian auth')}, ${pc.bold('meridian generate')}, ${pc.bold('meridian mcp install')}.`,
  );
  return 0;
}
