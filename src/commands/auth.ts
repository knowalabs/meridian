import pc from 'picocolors';
import { openVault } from '../core/vault.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { PROVIDERS } from '../providers/router.js';
import { log } from '../core/logger.js';
import { didYouMean, promptChoice, promptSecret } from '../core/prompt.js';

const KEY_PROVIDERS = PROVIDERS.filter((p) => p.needsKey).map((p) => p.id);

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function resolveProvider(provider?: string): Promise<string | null> {
  if (provider) {
    if (!KEY_PROVIDERS.includes(provider)) {
      log.fail(`Unknown provider "${provider}"`);
      const suggestion = didYouMean(provider, KEY_PROVIDERS);
      if (suggestion) log.info(`  Did you mean ${pc.bold(suggestion)}?`);
      log.dim(`  Supported: ${KEY_PROVIDERS.join(', ')}`);
      return null;
    }
    return provider;
  }
  log.title('Which provider is this key for?\n');
  const chosen = await promptChoice(
    'Pick a number:',
    KEY_PROVIDERS.map((p) => ({ value: p, label: p })),
  );
  if (!chosen) log.fail(`Unknown provider. Supported: ${KEY_PROVIDERS.join(', ')}`);
  return chosen;
}

export async function authCommand(provider?: string, keyArg?: string): Promise<number> {
  const chosen = await resolveProvider(provider);
  if (!chosen) return 1;

  const key = keyArg ?? (await promptSecret(`Enter ${chosen} API key (input hidden): `));
  if (!key) {
    log.fail('No key entered');
    return 1;
  }

  const vault = openVault();
  vault.set(chosen, key);

  const config = loadConfig();
  config.providers = [...new Set([...config.providers, chosen])].sort();
  saveConfig(config);

  log.ok(`Stored ${chosen} key ${pc.dim(`(${maskKey(key)})`)} in ${vault.backend === 'keychain' ? 'the OS keychain' : 'the encrypted vault'}`);
  return 0;
}

export function keysListCommand(): number {
  const vault = openVault();
  const keys = vault.list();
  log.title(`API Keys (${vault.backend})\n`);
  if (keys.length === 0) {
    log.info(`No keys stored. Run ${pc.bold('devpilot auth')} to add one.`);
    return 0;
  }
  for (const account of keys) {
    const value = vault.get(account);
    log.ok(`${account.padEnd(12)} ${pc.dim(value ? maskKey(value) : '(unreadable)')}`);
  }
  return 0;
}

export function keysRemoveCommand(provider: string): number {
  const vault = openVault();
  if (!vault.delete(provider)) {
    log.fail(`No stored key for "${provider}"`);
    return 1;
  }
  const config = loadConfig();
  config.providers = config.providers.filter((p) => p !== provider);
  saveConfig(config);
  log.ok(`Removed ${provider} key`);
  return 0;
}
