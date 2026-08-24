import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { meridianHome } from '../core/paths.js';
import { writeFileAtomic } from '../core/fsx.js';
import { VERSION } from '../core/pkg.js';

/**
 * Cache for the codebase-review pass — the single most expensive call in a
 * generate run, and the one `meridian sync` would otherwise repeat in full
 * every time even when nothing about the digest changed.
 *
 * The cache lives in the Meridian home, never in the target project: a
 * generated kit is committed, and a cache of AI output is not something a
 * user should find in their repository or accidentally commit.
 *
 * The key covers everything that could change the review — project root,
 * provider, model, Meridian version (the review prompt ships with it) and the
 * digest itself — so a stale entry is unreachable rather than wrong.
 *
 * Note that the very first `generate` on a project cannot hit: writing the kit
 * changes the project, so the digest that produced the review is no longer the
 * digest of the project afterwards. Hits start from the run after that, which
 * is exactly the `meridian sync` case this exists for.
 */

const CACHE_DIR = 'cache/reviews';
/** Entries older than this are never served; they are pruned on write. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound on retained entries, oldest evicted first. */
const MAX_ENTRIES = 50;

export interface ReviewKey {
  root: string;
  provider: string;
  model: string;
  digest: string;
}

interface CacheEntry {
  createdAt: string;
  provider: string;
  model: string;
  review: string;
  /**
   * Files the review pass asked to read beyond the digest. Recorded so a cache
   * hit can serve them again from disk — the review was written knowing them,
   * and the artifact kinds that build on it must see the same evidence.
   */
  requested?: string[];
}

/** A cached review together with the extra files it was written from. */
export interface CachedReview {
  review: string;
  requested: string[];
}

export function reviewCacheKey(key: ReviewKey): string {
  return crypto
    .createHash('sha256')
    .update([VERSION, key.root, key.provider, key.model, key.digest].join('\0'))
    .digest('hex');
}

function cacheDir(): string {
  return path.join(meridianHome(), CACHE_DIR);
}

function entryPath(hash: string): string {
  return path.join(cacheDir(), `${hash}.json`);
}

/** The cached review for this exact digest, or null. Never throws. */
export function readCachedReview(key: ReviewKey): CachedReview | null {
  try {
    const file = entryPath(reviewCacheKey(key));
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEntry;
    if (typeof entry.review !== 'string' || !entry.review) return null;
    if (Date.now() - Date.parse(entry.createdAt) > MAX_AGE_MS) return null;
    return {
      review: entry.review,
      requested: Array.isArray(entry.requested)
        ? entry.requested.filter((f): f is string => typeof f === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

/** Store a review. Best-effort: a cache write must never fail a generate run. */
export function writeCachedReview(key: ReviewKey, cached: CachedReview): void {
  try {
    const entry: CacheEntry = {
      createdAt: new Date().toISOString(),
      provider: key.provider,
      model: key.model,
      review: cached.review,
      requested: cached.requested,
    };
    writeFileAtomic(entryPath(reviewCacheKey(key)), JSON.stringify(entry, null, 2) + '\n');
    pruneCache();
  } catch {
    /* the cache is an optimization — losing it costs one extra AI call */
  }
}

/** Drop expired entries, then the oldest ones beyond MAX_ENTRIES. */
function pruneCache(): void {
  const dir = cacheDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  const stamped: { file: string; mtime: number }[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const { mtimeMs } = fs.statSync(full);
      if (Date.now() - mtimeMs > MAX_AGE_MS) fs.unlinkSync(full);
      else stamped.push({ file: full, mtime: mtimeMs });
    } catch {
      /* raced with another run — leave it alone */
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of stamped.slice(MAX_ENTRIES)) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
}
