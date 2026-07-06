import pc from 'picocolors';
import { buildRegistry } from '../plugins/tools.js';
import { log } from '../core/logger.js';
import { didYouMean, promptChoice } from '../core/prompt.js';
import type { ToolPlugin } from '../core/plugin.js';

function unknownTool(tool: string, ids: string[], extra: string[] = []): void {
  log.fail(`Unknown tool "${tool}"`);
  const suggestion = didYouMean(tool, [...ids, ...extra]);
  if (suggestion) log.info(`  Did you mean ${pc.bold(suggestion)}?`);
  log.dim(`  Supported: ${[...ids, ...extra].join(', ')}`);
}

/** Interactive picker used when no tool argument was given. */
async function pickTool(
  registry: ReturnType<typeof buildRegistry>,
  verb: string,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    log.fail(`Missing tool name. Usage: ${pc.bold(`devpilot ${verb} <tool>`)}`);
    log.dim(`  Supported: ${registry.ids().join(', ')}${verb === 'install' ? ', all' : ''}`);
    return null;
  }
  log.title(`Which tool do you want to ${verb}?\n`);
  const choices = registry.all().map((plugin) => ({
    value: plugin.id,
    label: `${plugin.name} ${pc.dim(`· ${plugin.id}`)}`,
    note: plugin.doctor().installed ? 'installed' : undefined,
  }));
  if (verb === 'install')
    choices.push({ value: 'all', label: pc.bold('Everything'), note: 'install all tools' });
  const chosen = await promptChoice('Pick a number (or press Enter to cancel):', choices);
  if (!chosen) log.dim('Cancelled.');
  return chosen;
}

export async function installCommand(tool?: string): Promise<number> {
  const registry = buildRegistry();

  const chosen = tool ?? (await pickTool(registry, 'install'));
  if (!chosen) return 1;

  let targets: ToolPlugin[];
  if (chosen === 'all') {
    targets = registry.all();
  } else {
    const plugin = registry.get(chosen);
    if (!plugin) {
      unknownTool(chosen, registry.ids(), ['all']);
      return 1;
    }
    targets = [plugin];
  }

  let failures = 0;
  for (const plugin of targets) {
    log.title(`${plugin.name}`);
    const ok = await plugin.install();
    if (!ok) {
      failures++;
      continue;
    }
    await plugin.configure();
    if (plugin.validate()) log.ok(`${plugin.name} is ready`);
    else {
      failures++;
      log.warn(
        `${plugin.name} installed but failed validation (restart your shell and run ${pc.bold('devpilot doctor')})`,
      );
    }
  }
  if (failures === 0 && targets.length > 0) {
    log.dim(
      `\nNext: run ${pc.bold('devpilot auth')} to store an API key, then ${pc.bold('devpilot init')} in your project.`,
    );
  }
  return failures === 0 ? 0 : 1;
}

export async function uninstallCommand(tool?: string): Promise<number> {
  const registry = buildRegistry();
  const chosen = tool ?? (await pickTool(registry, 'uninstall'));
  if (!chosen) return 1;

  const plugin = registry.get(chosen);
  if (!plugin) {
    unknownTool(chosen, registry.ids());
    return 1;
  }
  const ok = await plugin.uninstall();
  if (ok) log.ok(`${plugin.name} uninstalled`);
  return ok ? 0 : 1;
}

export async function updateToolsCommand(tool?: string): Promise<number> {
  const registry = buildRegistry();
  const targets = tool && tool !== 'all' ? [registry.get(tool)].filter(Boolean) : registry.all();
  if (targets.length === 0) {
    unknownTool(tool ?? '', registry.ids(), ['all']);
    return 1;
  }
  let failures = 0;
  for (const plugin of targets) {
    if (!plugin!.doctor().installed) continue;
    log.info(`Updating ${plugin!.name}…`);
    if (!(await plugin!.update())) {
      failures++;
      log.warn(`${plugin!.name} failed to update`);
    }
  }
  if (failures === 0) {
    log.ok('Update complete');
    return 0;
  }
  log.fail(`${failures} tool(s) failed to update`);
  return 1;
}
