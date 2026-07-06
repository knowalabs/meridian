import pc from 'picocolors';
import { buildRegistry } from '../plugins/tools.js';
import { jsonMode, log } from '../core/logger.js';

interface ToolStatus {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  hint: string | null;
}

export function doctorCommand(): number {
  const registry = buildRegistry();
  const tools: ToolStatus[] = registry.all().map((plugin) => {
    const report = plugin.doctor();
    return {
      id: plugin.id,
      name: plugin.name,
      installed: report.installed,
      version: report.version ?? null,
      hint: report.hint ?? null,
    };
  });
  const missing = tools.filter((t) => !t.installed);

  if (jsonMode()) {
    log.json({ tools, missing: missing.length });
    return 0;
  }

  log.title('DevPilot Doctor — checking your AI development environment\n');
  for (const tool of tools) {
    if (tool.installed) {
      log.ok(`${tool.name.padEnd(12)} ${pc.dim(tool.version ?? '')}`);
    } else {
      log.fail(
        `${tool.name.padEnd(12)} not found ${tool.hint ? pc.dim(`— install: ${tool.hint}`) : ''}`,
      );
    }
  }

  log.info('');
  if (missing.length === 0) {
    log.ok('All supported tools are installed.');
  } else {
    log.warn(
      `${missing.length} tool(s) missing. Run ${pc.bold('devpilot install <tool>')} or ${pc.bold('devpilot install all')}.`,
    );
  }
  return 0;
}
