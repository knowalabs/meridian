import type { DevPilotConfig } from './config.js';

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Merge parsed (untrusted) config JSON into a defaults object, keeping only
 * fields with the expected types. Unknown or mistyped fields are dropped.
 */
export function coerceConfig(parsed: unknown, base: DevPilotConfig): DevPilotConfig {
  if (!isRecord(parsed)) return base;
  if (typeof parsed.version === 'number') base.version = parsed.version;
  if (typeof parsed.telemetry === 'boolean') base.telemetry = parsed.telemetry;
  if (isRecord(parsed.router)) {
    const r = parsed.router;
    if (typeof r.prefer === 'string') base.router.prefer = r.prefer;
    if (r.optimize === 'cost' || r.optimize === 'speed' || r.optimize === 'quality') {
      base.router.optimize = r.optimize;
    }
    if (isRecord(r.models)) {
      const models: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.models)) if (typeof v === 'string') models[k] = v;
      if (Object.keys(models).length > 0) base.router.models = models;
    }
  }
  if (Array.isArray(parsed.providers)) {
    base.providers = parsed.providers.filter((p): p is string => typeof p === 'string');
  }
  return base;
}

/** True when a parsed tool config is safe to merge `mcpServers` into. */
export function looksLikeMcpConfig(x: unknown): x is { mcpServers?: Record<string, unknown> } {
  return isRecord(x) && (x.mcpServers === undefined || isRecord(x.mcpServers));
}
