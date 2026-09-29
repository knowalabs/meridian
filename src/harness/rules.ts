import path from 'node:path';
import { readJsonFile } from '../core/fsx.js';

/**
 * The permission-rule grammar the `harness` artifact kind already writes into
 * `.claude/settings.json` — `Bash(npm run test:*)`, `Edit(docs/**)`,
 * `Read(./.env)`. The harness reads the kit's own rules rather than inventing
 * a second grammar, so one checked-in file governs every agent it drives.
 */
export interface PermissionRule {
  tool: string;
  /** What the rule is scoped to, or null for the bare tool (`Edit`). */
  specifier: string | null;
}

/** A shell command a rule allows: an exact command, or any command starting with `prefix`. */
export interface CommandRule {
  prefix: string;
  exact: boolean;
}

export function parseRule(text: string): PermissionRule | null {
  const match = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(text.trim());
  if (!match) return null;
  const specifier = match[2]?.trim();
  return { tool: match[1]!, specifier: specifier ? specifier : null };
}

/**
 * The command a `Bash(...)` rule allows. Both prefix spellings Claude Code
 * accepts are read — the legacy `npm test:*` and the current `npm test *`.
 * A bare `Bash` or a wildcard-only rule allows every command; that is never
 * translated into an allow-list entry for another agent, so it maps to null.
 */
export function commandRule(rule: PermissionRule): CommandRule | null {
  if (rule.tool !== 'Bash' || !rule.specifier) return null;
  const prefixed = /^(.*?)(?::\*| \*)$/.exec(rule.specifier);
  if (prefixed) {
    const prefix = prefixed[1]!.trim();
    return prefix ? { prefix, exact: false } : null;
  }
  return rule.specifier === '*' ? null : { prefix: rule.specifier, exact: true };
}

export interface KitPermissions {
  allow: PermissionRule[];
  ask: PermissionRule[];
  deny: PermissionRule[];
}

function isSettings(x: unknown): x is { permissions?: Record<string, unknown> } {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * The kit's permission rules, or null when the project has no readable
 * `.claude/settings.json`. Unparseable entries are dropped, not fatal: a
 * hand-edited settings file must never stop an agent run.
 */
export function readKitPermissions(root: string): KitPermissions | null {
  const res = readJsonFile(path.join(root, '.claude', 'settings.json'), isSettings);
  if (!res.ok) return null;
  const perms = res.value.permissions ?? {};
  const list = (key: string): PermissionRule[] => {
    const raw = perms[key];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((r) => {
      const rule = typeof r === 'string' ? parseRule(r) : null;
      return rule ? [rule] : [];
    });
  };
  return { allow: list('allow'), ask: list('ask'), deny: list('deny') };
}
