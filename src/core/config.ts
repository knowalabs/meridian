import fs from 'node:fs';
import { ensureHome, globalConfigPath } from './paths.js';

export interface RouterConfig {
  /** Preferred provider id, e.g. "anthropic". Empty = auto. */
  prefer?: string;
  /** Optimize for "cost" | "speed" | "quality". */
  optimize?: 'cost' | 'speed' | 'quality';
}

export interface DevPilotConfig {
  version: number;
  telemetry: boolean;
  router: RouterConfig;
  /** Providers the user has configured keys for (informational cache). */
  providers: string[];
}

const DEFAULT_CONFIG: DevPilotConfig = {
  version: 1,
  telemetry: false,
  router: { optimize: 'quality' },
  providers: [],
};

function defaults(): DevPilotConfig {
  // Deep copy — callers mutate the returned config, and a shared nested
  // `router` object would leak state between loads.
  return { ...DEFAULT_CONFIG, router: { ...DEFAULT_CONFIG.router }, providers: [] };
}

export function loadConfig(): DevPilotConfig {
  const file = globalConfigPath();
  if (!fs.existsSync(file)) return defaults();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DevPilotConfig>;
    return { ...defaults(), ...parsed, router: { ...DEFAULT_CONFIG.router, ...parsed.router } };
  } catch {
    return defaults();
  }
}

export function saveConfig(config: DevPilotConfig): void {
  ensureHome();
  fs.writeFileSync(globalConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
