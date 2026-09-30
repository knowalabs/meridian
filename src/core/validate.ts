import type { MeridianConfig } from './config.js';

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Merge parsed (untrusted) config JSON into a defaults object, keeping only
 * fields with the expected types. Unknown or mistyped fields are dropped.
 */
export function coerceConfig(parsed: unknown, base: MeridianConfig): MeridianConfig {
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
    if (isRecord(r.pricing)) {
      const pricing: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {};
      for (const [model, value] of Object.entries(r.pricing)) {
        if (!isRecord(value)) continue;
        const input = value.inputPerMTok;
        const output = value.outputPerMTok;
        // A negative or non-numeric price would render as a nonsense estimate.
        if (typeof input === 'number' && typeof output === 'number' && input >= 0 && output >= 0) {
          pricing[model] = { inputPerMTok: input, outputPerMTok: output };
        }
      }
      if (Object.keys(pricing).length > 0) base.router.pricing = pricing;
    }
  }
  if (Array.isArray(parsed.providers)) {
    base.providers = parsed.providers.filter((p): p is string => typeof p === 'string');
  }
  if (isRecord(parsed.harness)) {
    const h = parsed.harness;
    const harness: NonNullable<MeridianConfig['harness']> = {};
    if (h.mode === 'plan' || h.mode === 'edit' || h.mode === 'auto') harness.mode = h.mode;
    // More repair turns than this is a loop, not a repair.
    const repairs = h.maxRepairs;
    if (typeof repairs === 'number' && Number.isInteger(repairs) && repairs >= 0 && repairs <= 5) {
      harness.maxRepairs = repairs;
    }
    if (Array.isArray(h.verify)) {
      const verify = h.verify.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
      if (verify.length > 0) harness.verify = verify;
    }
    if (typeof h.learn === 'boolean') harness.learn = h.learn;
    if (Object.keys(harness).length > 0) base.harness = harness;
  }
  return base;
}

/** True when a parsed tool config is safe to merge `mcpServers` into. */
export function looksLikeMcpConfig(x: unknown): x is { mcpServers?: Record<string, unknown> } {
  return isRecord(x) && (x.mcpServers === undefined || isRecord(x.mcpServers));
}
