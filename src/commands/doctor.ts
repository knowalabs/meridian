import pc from 'picocolors';
import { buildRegistry } from '../plugins/tools.js';
import { log } from '../core/logger.js';

export function doctorCommand(): number {
  const registry = buildRegistry();
  log.title('DevPilot Doctor — checking your AI development environment\n');

  let missing = 0;
  for (const plugin of registry.all()) {
    const report = plugin.doctor();
    if (report.installed) {
      log.ok(`${plugin.name.padEnd(12)} ${pc.dim(report.version ?? '')}`);
    } else {
      missing++;
      log.fail(`${plugin.name.padEnd(12)} not found ${report.hint ? pc.dim(`— install: ${report.hint}`) : ''}`);
    }
  }

  log.info('');
  if (missing === 0) {
    log.ok('All supported tools are installed.');
  } else {
    log.warn(`${missing} tool(s) missing. Run ${pc.bold('devpilot install <tool>')} or ${pc.bold('devpilot install all')}.`);
  }
  return 0;
}
