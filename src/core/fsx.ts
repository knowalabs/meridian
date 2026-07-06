import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename over the target. A crash mid-write can no longer truncate the file.
 */
export function writeFileAtomic(file: string, data: string, opts: { mode?: number } = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : {});
  fs.renameSync(tmp, file);
}

/** Copy a file to `<file>.bak-<timestamp>`; returns the backup path, or null if missing. */
export function backupFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, backup);
  return backup;
}

export type JsonReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' | 'malformed' | 'invalid'; detail?: string };

/**
 * Read and parse a JSON file without throwing. `missing` = unreadable,
 * `malformed` = not valid JSON, `invalid` = failed the shape validator.
 */
export function readJsonFile<T>(
  file: string,
  validate?: (x: unknown) => x is T,
): JsonReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (validate && !validate(parsed)) return { ok: false, reason: 'invalid' };
  return { ok: true, value: parsed as T };
}
