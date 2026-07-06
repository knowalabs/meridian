import pc from 'picocolors';
import { getMcp, MCP_REGISTRY, searchMcp } from '../mcp/registry.js';
import { addServer, listInstalled, removeServer } from '../mcp/configure.js';
import { jsonMode, log } from '../core/logger.js';

export function mcpSearchCommand(query?: string): number {
  const results = query ? searchMcp(query) : MCP_REGISTRY;
  const installed = new Set(listInstalled());
  if (jsonMode()) {
    log.json({
      results: results.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        installed: installed.has(s.id),
      })),
    });
    return results.length === 0 ? 1 : 0;
  }
  if (results.length === 0) {
    log.warn(`No MCP servers matching "${query}"`);
    return 1;
  }
  log.title(`MCP servers${query ? ` matching "${query}"` : ''}:\n`);
  for (const s of results) {
    const mark = installed.has(s.id) ? pc.green(' (installed)') : '';
    log.info(`  ${pc.bold(s.id.padEnd(12))} ${s.description}${mark}`);
  }
  log.info(`\nInstall with ${pc.bold('devpilot mcp install <id>')}`);
  return 0;
}

export function mcpInstallCommand(id: string, cwd: string = process.cwd()): number {
  const spec = getMcp(id);
  if (!spec) {
    log.fail(`Unknown MCP server "${id}". Try ${pc.bold('devpilot mcp search')}`);
    return 1;
  }
  const report = addServer(spec, cwd);
  log.ok(`Installed MCP server ${pc.bold(spec.name)}`);
  for (const f of report.touched) log.dim(`  configured ${f}`);
  for (const s of report.skipped) {
    log.warn(
      `Skipped ${s.file}: ${s.reason}.` +
        (s.backup ? ` A backup was saved to ${s.backup}.` : '') +
        ' Fix or remove the file and re-run.',
    );
  }
  if (spec.env?.length) {
    // Configs reference these as ${VAR}; the actual values stay in the
    // user's environment, never in the config files.
    const missing = spec.env.filter((name) => !process.env[name]);
    log.info(`This server reads these environment variables: ${spec.env.join(', ')}`);
    if (missing.length) {
      log.warn(`Not currently set in your environment: ${missing.join(', ')}`);
    }
  }
  return report.skipped.length > 0 && report.touched.length === 0 ? 1 : 0;
}

export function mcpRemoveCommand(id: string, cwd: string = process.cwd()): number {
  const report = removeServer(id, cwd);
  for (const s of report.skipped) {
    log.warn(
      `Skipped ${s.file}: ${s.reason}.` +
        (s.backup ? ` A backup was saved to ${s.backup}.` : '') +
        ' Fix or remove the file and re-run.',
    );
  }
  if (report.touched.length === 0) {
    log.warn(`MCP server "${id}" was not configured anywhere`);
    return 1;
  }
  log.ok(`Removed MCP server ${pc.bold(id)}`);
  for (const f of report.touched) log.dim(`  updated ${f}`);
  return 0;
}

export function mcpListCommand(): number {
  const installed = listInstalled();
  if (jsonMode()) {
    log.json({
      installed: installed.map((id) => {
        const spec = getMcp(id);
        return { id, name: spec?.name ?? null, description: spec?.description ?? null };
      }),
    });
    return 0;
  }
  if (installed.length === 0) {
    log.info(`No MCP servers installed. Browse with ${pc.bold('devpilot mcp search')}`);
    return 0;
  }
  log.title('Installed MCP servers:\n');
  for (const id of installed) {
    const spec = getMcp(id);
    log.ok(`${id.padEnd(12)} ${pc.dim(spec?.description ?? '')}`);
  }
  return 0;
}
