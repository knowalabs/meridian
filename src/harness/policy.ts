import type { HarnessMode } from './events.js';
import { commandRule, readKitPermissions, type CommandRule } from './rules.js';

/**
 * What an agent may do on its own in one session. Each driver translates this
 * into its CLI's native flags; nothing here knows any CLI. Every mode is
 * non-interactive — an action outside the policy is denied and reported as a
 * `permission.denied` event, never silently allowed.
 */
export interface DriverPolicy {
  mode: HarnessMode;
  /** Shell commands the agent may run without asking. Empty in plan mode. */
  allowCommands: CommandRule[];
  /** Where `allowCommands` came from, so a run can say why a command was allowed. */
  source: 'kit' | 'verify-chain' | 'none';
}

/**
 * The policy for a session. The kit's own `Bash(...)` allow rules win: the
 * team already reviewed that list, in the file they commit. A project without
 * a kit gets its verification chain instead, so an agent can at least run the
 * checks it will be judged by.
 */
export function policyFor(root: string, mode: HarnessMode, verifyCommands: string[]): DriverPolicy {
  if (mode === 'plan') return { mode, allowCommands: [], source: 'none' };
  const kit = readKitPermissions(root);
  const fromKit = (kit?.allow ?? []).flatMap((rule) => {
    const cmd = commandRule(rule);
    return cmd ? [cmd] : [];
  });
  if (fromKit.length) return { mode, allowCommands: dedupe(fromKit), source: 'kit' };
  const fromChain = verifyCommands.flatMap((prefix) => [
    { prefix, exact: true },
    { prefix, exact: false },
  ]);
  return {
    mode,
    allowCommands: dedupe(fromChain),
    source: fromChain.length ? 'verify-chain' : 'none',
  };
}

function dedupe(rules: CommandRule[]): CommandRule[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    const key = `${r.exact ? '=' : '^'}${r.prefix}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
