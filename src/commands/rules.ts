import path from 'node:path';
import pc from 'picocolors';
import { generateRules, RULE_TARGETS } from '../rules/generators.js';
import { log } from '../core/logger.js';

export function rulesGenerateCommand(only: string[], cwd: string = process.cwd()): number {
  const unknown = only.filter((t) => !RULE_TARGETS.some((r) => r.id === t));
  if (unknown.length) {
    log.fail(`Unknown target(s): ${unknown.join(', ')}. Supported: ${RULE_TARGETS.map((r) => r.id).join(', ')}`);
    return 1;
  }
  const written = generateRules(cwd, path.basename(cwd), only);
  log.title('Generated instruction files:\n');
  for (const w of written) log.ok(`${w.target.padEnd(16)} ${pc.dim(w.file)}`);
  log.info(`\nEdit ${pc.bold('.devpilot/rules.md')} and re-run to update all tools at once.`);
  return 0;
}

export function rulesListCommand(): number {
  log.title('Rule targets:\n');
  for (const t of RULE_TARGETS) log.ok(`${t.id.padEnd(10)} → ${t.file}`);
  return 0;
}
