import pc from 'picocolors';
import { getMcp, MCP_REGISTRY, searchMcp } from '../mcp/registry.js';
import { addServer, listInstalled, removeServer } from '../mcp/configure.js';
import { log } from '../core/logger.js';

export function mcpSearchCommand(query?: string): number {
  const results = query ? searchMcp(query) : MCP_REGISTRY;
  if (results.length === 0) {
    log.warn(`No MCP servers matching "${query}"`);
    return 1;
  }
  const installed = new Set(listInstalled());
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
  const touched = addServer(spec, cwd);
  log.ok(`Installed MCP server ${pc.bold(spec.name)}`);
  for (const f of touched) log.dim(`  configured ${f}`);
  const missingEnv = (spec.env ?? []).filter((name) => !process.env[name]);
  if (missingEnv.length) {
    log.warn(`Set these environment variables before use: ${missingEnv.join(', ')}`);
  }
  return 0;
}

export function mcpRemoveCommand(id: string, cwd: string = process.cwd()): number {
  const touched = removeServer(id, cwd);
  if (touched.length === 0) {
    log.warn(`MCP server "${id}" was not configured anywhere`);
    return 1;
  }
  log.ok(`Removed MCP server ${pc.bold(id)}`);
  for (const f of touched) log.dim(`  updated ${f}`);
  return 0;
}

export function mcpListCommand(): number {
  const installed = listInstalled();
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
