import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.js';
import { writeFileAtomic, backupFile } from './fsx.js';
import { log } from './logger.js';
import { run, which } from './exec.js';
import { meridianHome, ensureHome } from './paths.js';

const SERVICE = 'meridian';

export type VaultBackend = 'keychain' | 'secret-service' | 'dpapi-file' | 'encrypted-file';

export interface Vault {
  backend: VaultBackend;
  set(account: string, secret: string): void;
  get(account: string): string | null;
  delete(account: string): boolean;
  list(): string[];
}

/* ------------------------------ macOS Keychain ------------------------------ */

class KeychainVault implements Vault {
  readonly backend = 'keychain' as const;

  set(account: string, secret: string): void {
    // Prefer `security -i` (commands via stdin) so the secret never appears
    // in the process argument list; fall back to argv if unavailable.
    const escaped = `"${secret.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const viaStdin = run(
      'security',
      ['-i'],
      `add-generic-password -U -s ${SERVICE} -a ${account} -w ${escaped}\n`,
    );
    if (!viaStdin.ok) {
      const res = run('security', [
        'add-generic-password',
        '-U',
        '-s',
        SERVICE,
        '-a',
        account,
        '-w',
        secret,
      ]);
      if (!res.ok) throw new CliError(`keychain write failed: ${res.stderr}`);
    }
    indexAdd(account);
  }

  get(account: string): string | null {
    const res = run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    return res.ok ? res.stdout : null;
  }

  delete(account: string): boolean {
    const res = run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
    indexRemove(account);
    return res.ok;
  }

  list(): string[] {
    return indexRead();
  }
}

/* --------------------------- Linux Secret Service --------------------------- */

/** libsecret via `secret-tool`; the secret travels over stdin, never argv. */
class SecretToolVault implements Vault {
  readonly backend = 'secret-service' as const;

  set(account: string, secret: string): void {
    const res = run(
      'secret-tool',
      ['store', `--label=${SERVICE} ${account}`, 'service', SERVICE, 'account', account],
      secret,
    );
    if (!res.ok) throw new CliError(`secret-tool write failed: ${res.stderr}`);
    indexAdd(account);
  }

  get(account: string): string | null {
    const res = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    return res.ok && res.stdout ? res.stdout : null;
  }

  delete(account: string): boolean {
    const res = run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
    indexRemove(account);
    return res.ok;
  }

  list(): string[] {
    return indexRead();
  }
}

/*
 * Neither the macOS `security` CLI nor `secret-tool` can reliably enumerate
 * items for a service, so we keep a non-secret index of account names on disk.
 */
function indexPath(): string {
  return path.join(meridianHome(), 'keys', 'index.json');
}
function indexRead(): string[] {
  try {
    return JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as string[];
  } catch {
    return [];
  }
}
function indexWrite(names: string[]): void {
  ensureHome();
  writeFileAtomic(indexPath(), JSON.stringify([...new Set(names)].sort(), null, 2), {
    mode: 0o600,
  });
}
function indexAdd(name: string): void {
  indexWrite([...indexRead(), name]);
}
function indexRemove(name: string): void {
  indexWrite(indexRead().filter((n) => n !== name));
}

/* ----------------------------- master-key wrapping ---------------------------- */
/*
 * The file vault's AES-256-GCM master key is stored on disk. Where the OS
 * offers user-scoped key protection (Windows DPAPI), the stored key is
 * wrapped with it; otherwise it is stored as plain hex protected only by
 * file permissions (a no-op on Windows — hence DPAPI there).
 */

interface KeyProtector {
  /** Serialize a raw 32-byte key for storage. */
  protect(raw: Buffer): string;
  /** Recover the raw key from its stored form. */
  unprotect(stored: string): Buffer;
}

class PlainProtector implements KeyProtector {
  protect(raw: Buffer): string {
    return raw.toString('hex');
  }
  unprotect(stored: string): Buffer {
    return Buffer.from(stored.trim(), 'hex');
  }
}

const DPAPI_PREFIX = 'dpapi:';

/** Windows DPAPI (CurrentUser) via PowerShell — no native modules needed. */
class DpapiProtector implements KeyProtector {
  private ps(script: string, input: string): string {
    const res = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], input);
    if (!res.ok) throw new CliError(`DPAPI operation failed: ${res.stderr || res.error || ''}`);
    return res.stdout.trim();
  }

  protect(raw: Buffer): string {
    const out = this.ps(
      `Add-Type -AssemblyName System.Security; ` +
        `$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
        `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($raw,$null,'CurrentUser'))`,
      raw.toString('base64'),
    );
    return DPAPI_PREFIX + out;
  }

  unprotect(stored: string): Buffer {
    if (!stored.startsWith(DPAPI_PREFIX)) return new PlainProtector().unprotect(stored); // legacy plain key
    const out = this.ps(
      `Add-Type -AssemblyName System.Security; ` +
        `$blob=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
        `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($blob,$null,'CurrentUser'))`,
      stored.slice(DPAPI_PREFIX.length).trim(),
    );
    return Buffer.from(out, 'base64');
  }
}

/** Restrict a directory to the current user on Windows (0o600 is a no-op there). */
function restrictWindowsAcl(dir: string): void {
  const user = process.env.USERNAME;
  if (!user) return;
  run('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`]);
}

/* --------------------------- Encrypted file vault --------------------------- */
/*
 * Fallback for platforms without a supported OS secret store. Secrets are
 * stored in a single AES-256-GCM encrypted blob; the 256-bit master key
 * lives in a separate 0600 file, DPAPI-wrapped on Windows. Secrets are
 * never written in plaintext.
 */

class FileVault implements Vault {
  readonly backend: VaultBackend;
  private readonly protector: KeyProtector;

  constructor(
    protector: KeyProtector = new PlainProtector(),
    backend: VaultBackend = 'encrypted-file',
  ) {
    this.protector = protector;
    this.backend = backend;
  }

  private masterKeyPath(): string {
    return path.join(meridianHome(), 'keys', '.master');
  }
  private vaultPath(): string {
    return path.join(meridianHome(), 'keys', 'vault.enc');
  }

  private masterKey(): Buffer {
    ensureHome();
    const p = this.masterKeyPath();
    if (fs.existsSync(p)) return this.protector.unprotect(fs.readFileSync(p, 'utf8'));
    const key = crypto.randomBytes(32);
    if (process.platform === 'win32') restrictWindowsAcl(path.dirname(p));
    writeFileAtomic(p, this.protector.protect(key), { mode: 0o600 });
    return key;
  }

  private readAll(): Record<string, string> {
    const p = this.vaultPath();
    if (!fs.existsSync(p)) return {};
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const { iv, tag, data } = JSON.parse(raw) as { iv: string; tag: string; data: string };
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.masterKey(),
        Buffer.from(iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'hex'));
      const plain = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as Record<string, string>;
    } catch (err) {
      throw new CliError(`The key vault could not be read: ${p}`, {
        hint: 'The vault file is corrupted or its master key changed. Back up the keys directory, then run "meridian keys repair" and re-add your keys with "meridian auth".',
        cause: err,
      });
    }
  }

  private writeAll(entries: Record<string, string>): void {
    ensureHome();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(entries), 'utf8'), cipher.final()]);
    const payload = {
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data: data.toString('hex'),
    };
    writeFileAtomic(this.vaultPath(), JSON.stringify(payload), { mode: 0o600 });
  }

  set(account: string, secret: string): void {
    const all = this.readAll();
    all[account] = secret;
    this.writeAll(all);
  }

  get(account: string): string | null {
    return this.readAll()[account] ?? null;
  }

  delete(account: string): boolean {
    const all = this.readAll();
    if (!(account in all)) return false;
    delete all[account];
    this.writeAll(all);
    return true;
  }

  list(): string[] {
    return Object.keys(this.readAll()).sort();
  }
}

/* ---------------------------------- repair ---------------------------------- */

/**
 * Back up and remove the file-vault state so a corrupted vault can be
 * reinitialized. Returns the backups that were made.
 */
export function repairVault(): string[] {
  const keysDir = path.join(meridianHome(), 'keys');
  const backups: string[] = [];
  for (const name of ['vault.enc', '.master', 'index.json']) {
    const file = path.join(keysDir, name);
    const backup = backupFile(file);
    if (backup) {
      backups.push(backup);
      fs.rmSync(file);
    }
  }
  return backups;
}

/* --------------------------------- factory --------------------------------- */

let warnedFallback = false;

export function openVault(): Vault {
  if (process.env.MERIDIAN_VAULT === 'file') return new FileVault();
  if (process.platform === 'darwin' && which('security')) return new KeychainVault();
  if (process.platform === 'linux' && which('secret-tool')) return new SecretToolVault();
  if (process.platform === 'win32' && which('powershell')) {
    return new FileVault(new DpapiProtector(), 'dpapi-file');
  }
  if ((process.platform === 'win32' || process.platform === 'linux') && !warnedFallback) {
    warnedFallback = true;
    log.warn(
      process.platform === 'win32'
        ? 'PowerShell not found — the vault master key is stored without OS protection.'
        : 'secret-tool (libsecret) not found — falling back to the encrypted file vault. Install libsecret-tools for OS-level key storage.',
    );
  }
  return new FileVault();
}
