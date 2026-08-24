import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { meridianHome, ensureHome } from '../core/paths.js';
import { backupFile, readJsonFile, writeFileAtomic } from '../core/fsx.js';
import { looksLikeMcpConfig } from '../core/validate.js';
import type { McpServerSpec } from './registry.js';

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpWriteReport {
  touched: string[];
  skipped: { file: string; reason: string; backup?: string }[];
}

/** Claude Desktop's config file location per platform. */
function claudeDesktopConfig(): string {
  const home = os.homedir();
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

/**
 * Tool config files that accept the standard `mcpServers` JSON shape.
 * Global targets are only written when their directory already exists
 * (i.e. the tool is installed); the project .mcp.json is always created.
 */
export function mcpConfigTargets(projectRoot: string): { name: string; file: string }[] {
  return [
    {
      name: 'Project (.mcp.json — Claude Code, Codex & others)',
      file: path.join(projectRoot, '.mcp.json'),
    },
    { name: 'Cursor (global)', file: path.join(os.homedir(), '.cursor', 'mcp.json') },
    { name: 'Gemini CLI (global)', file: path.join(os.homedir(), '.gemini', 'settings.json') },
    { name: 'Claude Desktop', file: claudeDesktopConfig() },
  ];
}

function toEntry(spec: McpServerSpec): McpServerEntry {
  const entry: McpServerEntry = { command: spec.command, args: spec.args };
  if (spec.env?.length) {
    // Write ${VAR} references, never resolved values: these config files are
    // frequently committed, and inlining would leak the user's secrets.
    entry.env = Object.fromEntries(spec.env.map((name) => [name, `\${${name}}`]));
  }
  return entry;
}

type ParsedConfig = { mcpServers?: Record<string, McpServerEntry> } & Record<string, unknown>;

/**
 * Read a tool config, refusing to proceed when the existing file is not
 * something we can merge into safely.
 */
function readConfig(
  file: string,
): { ok: true; config: ParsedConfig } | { ok: false; reason: string } {
  const result = readJsonFile(file, looksLikeMcpConfig);
  if (result.ok) return { ok: true, config: result.value as ParsedConfig };
  if (result.reason === 'missing') return { ok: true, config: { mcpServers: {} } };
  return {
    ok: false,
    reason:
      result.reason === 'malformed'
        ? 'the file is not valid JSON'
        : 'the file has an unexpected shape',
  };
}

function writeConfig(file: string, config: object): void {
  writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
}

function skip(report: McpWriteReport, file: string, reason: string): void {
  const backup = backupFile(file);
  report.skipped.push({ file, reason, ...(backup ? { backup } : {}) });
}

export function addServer(spec: McpServerSpec, projectRoot: string): McpWriteReport {
  const report: McpWriteReport = { touched: [], skipped: [] };
  for (const target of mcpConfigTargets(projectRoot)) {
    // Only touch global tool configs that already exist (tool is installed);
    // always create the project-level .mcp.json.
    const isProject = target.file.startsWith(projectRoot);
    if (!isProject && !fs.existsSync(path.dirname(target.file))) continue;
    const result = readConfig(target.file);
    if (!result.ok) {
      // Never overwrite a config we don't understand — that destroys data.
      skip(report, target.file, result.reason);
      continue;
    }
    const config = result.config;
    config.mcpServers = { ...config.mcpServers, [spec.id]: toEntry(spec) };
    writeConfig(target.file, config);
    report.touched.push(target.file);
  }
  recordInstalled(spec.id);
  return report;
}

export function removeServer(id: string, projectRoot: string): McpWriteReport {
  const report: McpWriteReport = { touched: [], skipped: [] };
  for (const target of mcpConfigTargets(projectRoot)) {
    if (!fs.existsSync(target.file)) continue;
    const result = readConfig(target.file);
    if (!result.ok) {
      skip(report, target.file, result.reason);
      continue;
    }
    const config = result.config;
    if (config.mcpServers && id in config.mcpServers) {
      delete config.mcpServers[id];
      writeConfig(target.file, config);
      report.touched.push(target.file);
    }
  }
  recordRemoved(id);
  return report;
}

/* Track installed servers in ~/.meridian/mcp/installed.json */

function installedPath(): string {
  return path.join(meridianHome(), 'mcp', 'installed.json');
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
  writeFileAtomic(
    installedPath(),
    JSON.stringify([...new Set([...listInstalled(), id])].sort(), null, 2),
  );
}

function recordRemoved(id: string): void {
  ensureHome();
  writeFileAtomic(
    installedPath(),
    JSON.stringify(
      listInstalled().filter((s) => s !== id),
      null,
      2,
    ),
  );
}
