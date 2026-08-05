import { ensureHome, globalConfigPath } from './paths.js';
import { backupFile, readJsonFile, writeFileAtomic } from './fsx.js';
import { coerceConfig } from './validate.js';
import { log } from './logger.js';

export interface RouterConfig {
  /** Preferred provider id, e.g. "anthropic". Empty = auto. */
  prefer?: string;
  /** Optimize for "cost" | "speed" | "quality". */
  optimize?: 'cost' | 'speed' | 'quality';
  /** Per-provider model overrides, e.g. { anthropic: "claude-opus-4-8" }. */
  models?: Record<string, string>;
  /**
   * Per-model USD price per million tokens, used by `knowa generate
   * --estimate`. Keyed by model id; overrides Knowa's built-in table.
   */
  pricing?: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

export interface KnowaConfig {
  version: number;
  telemetry: boolean;
  router: RouterConfig;
  /** Providers the user has configured keys for (informational cache). */
  providers: string[];
}

const DEFAULT_CONFIG: KnowaConfig = {
  version: 1,
  telemetry: false,
  router: { optimize: 'quality' },
  providers: [],
};

function defaults(): KnowaConfig {
  // Deep copy — callers mutate the returned config, and a shared nested
  // `router` object would leak state between loads.
  return { ...DEFAULT_CONFIG, router: { ...DEFAULT_CONFIG.router }, providers: [] };
}

export function loadConfig(): KnowaConfig {
  const file = globalConfigPath();
  const result = readJsonFile<unknown>(file);
  if (!result.ok) {
    if (result.reason === 'malformed') {
      const backup = backupFile(file);
      log.warn(
        `Config file is not valid JSON and was ignored: ${file}` +
          (backup ? `\n  A backup was saved to ${backup}` : ''),
      );
    }
    return defaults();
  }
  return coerceConfig(result.value, defaults());
}

export function saveConfig(config: KnowaConfig): void {
  ensureHome();
  writeFileAtomic(globalConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
