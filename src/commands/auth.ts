import pc from 'picocolors';
import { openVault, repairVault, type VaultBackend } from '../core/vault.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { PROVIDERS, verifyApiKey } from '../providers/router.js';
import { jsonMode, log } from '../core/logger.js';
import { startSpinner } from '../core/spinner.js';
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

const BACKEND_LABEL: Record<VaultBackend, string> = {
  keychain: 'the macOS Keychain',
  'secret-service': 'the OS secret service (libsecret)',
  'dpapi-file': 'the encrypted vault (DPAPI-protected key)',
  'encrypted-file': 'the encrypted vault',
};

export async function authCommand(
  provider?: string,
  keyArg?: string,
  opts: { verify?: boolean } = {},
): Promise<number> {
  const chosen = await resolveProvider(provider);
  if (!chosen) return 1;

  if (keyArg) {
    log.warn(
      'Keys passed as command arguments can be recorded in your shell history. ' +
        `Prefer ${pc.bold(`meridian auth ${chosen}`)} and the hidden prompt.`,
    );
  }
  const key = keyArg ?? (await promptSecret(`Enter ${chosen} API key (input hidden): `));
  if (!key) {
    log.fail('No key entered');
    return 1;
  }

  // Validate against the provider before touching the vault — a mistyped key
  // stored now would only surface as a confusing failure much later.
  if (opts.verify !== false) {
    const spin = startSpinner(`Verifying key with ${chosen}…`);
    const verdict = await verifyApiKey(chosen, key);
    if (verdict === 'invalid') {
      spin.fail(`${chosen} rejected this key — nothing was stored`);
      log.info(
        `  Double-check the key (masked: ${maskKey(key)}) and try again,` +
          ` or store it unchecked with ${pc.bold('--no-verify')}.`,
      );
      return 1;
    }
    if (verdict === 'unreachable') {
      spin.fail(`Could not reach ${chosen} to verify — storing the key unverified`);
    } else {
      spin.succeed(`Key accepted by ${chosen}`);
    }
  }

  const vault = openVault();
  vault.set(chosen, key);

  const config = loadConfig();
  config.providers = [...new Set([...config.providers, chosen])].sort();
  saveConfig(config);

  log.ok(`Stored ${chosen} key ${pc.dim(`(${maskKey(key)})`)} in ${BACKEND_LABEL[vault.backend]}`);
  return 0;
}

export function keysListCommand(): number {
  const vault = openVault();
  const keys = vault.list();
  if (jsonMode()) {
    log.json({
      backend: vault.backend,
      keys: keys.map((account) => {
        const value = vault.get(account);
        return { provider: account, masked: value ? maskKey(value) : null };
      }),
    });
    return 0;
  }
  log.title(`API Keys (${vault.backend})\n`);
  if (keys.length === 0) {
    log.info(`No keys stored. Run ${pc.bold('meridian auth')} to add one.`);
    return 0;
  }
  for (const account of keys) {
    const value = vault.get(account);
    log.ok(`${account.padEnd(12)} ${pc.dim(value ? maskKey(value) : '(unreadable)')}`);
  }
  return 0;
}

/** Back up and reinitialize a corrupted file vault. */
export function keysRepairCommand(): number {
  const backups = repairVault();
  if (backups.length === 0) {
    log.info('Nothing to repair — the vault is empty.');
    return 0;
  }
  for (const b of backups) log.dim(`  backed up ${b}`);
  log.ok(`Vault reinitialized. Re-add your keys with ${pc.bold('meridian auth')}.`);
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
