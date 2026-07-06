import { describe, expect, it } from 'vitest';
import { buildRegistry, TOOL_SPECS } from '../src/plugins/tools.js';
import { PluginRegistry } from '../src/core/plugin.js';

describe('plugin registry', () => {
  it('registers all supported tools from the product plan', () => {
    const registry = buildRegistry();
    for (const id of ['git', 'node', 'vscode', 'cursor', 'claude', 'codex', 'gemini', 'docker']) {
      expect(registry.get(id), `plugin ${id}`).toBeDefined();
    }
  });

  it('every plugin implements the full lifecycle contract', () => {
    for (const plugin of buildRegistry().all()) {
      for (const method of ['install', 'uninstall', 'configure', 'validate', 'update', 'doctor'] as const) {
        expect(typeof plugin[method], `${plugin.id}.${method}`).toBe('function');
      }
    }
  });

  it('rejects duplicate plugin ids', () => {
    const registry = new PluginRegistry();
    const plugin = buildRegistry().get('git')!;
    registry.register(plugin);
    expect(() => registry.register(plugin)).toThrow(/duplicate/);
  });

  it('doctor reports a hint for missing tools', () => {
    const spec = TOOL_SPECS.find((s) => s.id === 'claude')!;
    // Whatever the local machine state, doctor must return the report shape.
    const registry = buildRegistry();
    const report = registry.get(spec.id)!.doctor();
    expect(typeof report.installed).toBe('boolean');
    if (!report.installed) expect(report.hint).toBeTruthy();
  });
});
