import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devpilotHome, ensureHome } from '../core/paths.js';
import type { McpServerSpec } from './registry.js';

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers: Record<string, McpServerEntry>;
}

/** Tool config files that accept the standard `mcpServers` JSON shape. */
export function mcpConfigTargets(projectRoot: string): { name: string; file: string }[] {
  return [
    { name: 'Project (.mcp.json — Claude Code, Codex & others)', file: path.join(projectRoot, '.mcp.json') },
    { name: 'Cursor (global)', file: path.join(os.homedir(), '.cursor', 'mcp.json') },
    { name: 'Gemini CLI (global)', file: path.join(os.homedir(), '.gemini', 'settings.json') },
  ];
}

function toEntry(spec: McpServerSpec): McpServerEntry {
  const entry: McpServerEntry = { command: spec.command, args: spec.args };
  if (spec.env?.length) {
    entry.env = Object.fromEntries(spec.env.map((name) => [name, process.env[name] ?? '']));
  }
  return entry;
}

function readConfig(file: string): McpConfigFile & Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { mcpServers: {} };
  }
}

function writeConfig(file: string, config: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

export function addServer(spec: McpServerSpec, projectRoot: string): string[] {
  const touched: string[] = [];
  for (const target of mcpConfigTargets(projectRoot)) {
    // Only touch global tool configs that already exist (tool is installed);
    // always create the project-level .mcp.json.
    const isProject = target.file.startsWith(projectRoot);
    if (!isProject && !fs.existsSync(path.dirname(target.file))) continue;
    const config = readConfig(target.file);
    config.mcpServers = { ...config.mcpServers, [spec.id]: toEntry(spec) };
    writeConfig(target.file, config);
    touched.push(target.file);
  }
  recordInstalled(spec.id);
  return touched;
}

export function removeServer(id: string, projectRoot: string): string[] {
  const touched: string[] = [];
  for (const target of mcpConfigTargets(projectRoot)) {
    if (!fs.existsSync(target.file)) continue;
    const config = readConfig(target.file);
    if (config.mcpServers && id in config.mcpServers) {
      delete config.mcpServers[id];
      writeConfig(target.file, config);
      touched.push(target.file);
    }
  }
  recordRemoved(id);
  return touched;
}

/* Track installed servers in ~/.devpilot/mcp/installed.json */

function installedPath(): string {
  return path.join(devpilotHome(), 'mcp', 'installed.json');
}

export function listInstalled(): string[] {
  try {
    return JSON.parse(fs.readFileSync(installedPath(), 'utf8')) as string[];
  } catch {
    return [];
  }
}

function recordInstalled(id: string): void {
  ensureHome();
  fs.writeFileSync(installedPath(), JSON.stringify([...new Set([...listInstalled(), id])].sort(), null, 2));
}

function recordRemoved(id: string): void {
  ensureHome();
  fs.writeFileSync(installedPath(), JSON.stringify(listInstalled().filter((s) => s !== id), null, 2));
}
