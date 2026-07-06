import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run, which } from './exec.js';
import { devpilotHome, ensureHome } from './paths.js';

const SERVICE = 'devpilot';

export interface Vault {
  backend: 'keychain' | 'encrypted-file';
  set(account: string, secret: string): void;
  get(account: string): string | null;
  delete(account: string): boolean;
  list(): string[];
}

/* ------------------------------ macOS Keychain ------------------------------ */

class KeychainVault implements Vault {
  readonly backend = 'keychain' as const;

  set(account: string, secret: string): void {
    // -U updates the item if it already exists.
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
    if (!res.ok) throw new Error(`keychain write failed: ${res.stderr}`);
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

/*
 * The macOS `security` CLI has no reliable way to enumerate items for a
 * service, so we keep a non-secret index of account names on disk.
 */
function indexPath(): string {
  return path.join(devpilotHome(), 'keys', 'index.json');
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
  fs.writeFileSync(indexPath(), JSON.stringify([...new Set(names)].sort(), null, 2), {
    mode: 0o600,
  });
}
function indexAdd(name: string): void {
  indexWrite([...indexRead(), name]);
}
function indexRemove(name: string): void {
  indexWrite(indexRead().filter((n) => n !== name));
}

/* --------------------------- Encrypted file vault --------------------------- */
/*
 * Fallback for platforms without a supported keychain. Secrets are stored in
 * a single AES-256-GCM encrypted blob; the random 256-bit master key lives in
 * a separate 0600 file. Secrets are never written in plaintext.
 */

class FileVault implements Vault {
  readonly backend = 'encrypted-file' as const;

  private masterKeyPath(): string {
    return path.join(devpilotHome(), 'keys', '.master');
  }
  private vaultPath(): string {
    return path.join(devpilotHome(), 'keys', 'vault.enc');
  }

  private masterKey(): Buffer {
    ensureHome();
    const p = this.masterKeyPath();
    if (fs.existsSync(p)) return Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex');
    const key = crypto.randomBytes(32);
    fs.writeFileSync(p, key.toString('hex'), { mode: 0o600 });
    return key;
  }

  private readAll(): Record<string, string> {
    const p = this.vaultPath();
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, 'utf8');
    const { iv, tag, data } = JSON.parse(raw) as { iv: string; tag: string; data: string };
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey(), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as Record<string, string>;
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
    fs.writeFileSync(this.vaultPath(), JSON.stringify(payload), { mode: 0o600 });
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

/* --------------------------------- factory --------------------------------- */

export function openVault(): Vault {
  if (process.env.DEVPILOT_VAULT === 'file') return new FileVault();
  if (process.platform === 'darwin' && which('security')) return new KeychainVault();
  return new FileVault();
}
