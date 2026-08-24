/**
 * Plugin contract (architecture/plugin-system.md): every tool plugin
 * implements install(), uninstall(), configure(), validate(), update()
 * and doctor().
 */

export interface DoctorReport {
  installed: boolean;
  version?: string;
  /** Actionable hint when the tool is missing or misconfigured. */
  hint?: string;
}

export interface ToolPlugin {
  /** Stable identifier used on the CLI, e.g. "claude". */
  id: string;
  /** Human-readable name, e.g. "Claude Code". */
  name: string;
  doctor(): DoctorReport;
  install(): Promise<boolean> | boolean;
  uninstall(): Promise<boolean> | boolean;
  /** Apply Meridian-managed configuration (rules, MCP, etc.). */
  configure(): Promise<boolean> | boolean;
  /** Verify the tool works after install/configure. */
  validate(): boolean;
  update(): Promise<boolean> | boolean;
}

export class PluginRegistry {
  private plugins = new Map<string, ToolPlugin>();

  register(plugin: ToolPlugin): void {
    if (this.plugins.has(plugin.id)) throw new Error(`duplicate plugin id: ${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
  }

  get(id: string): ToolPlugin | undefined {
    return this.plugins.get(id);
  }

  all(): ToolPlugin[] {
    return [...this.plugins.values()];
  }

  ids(): string[] {
    return [...this.plugins.keys()];
  }
}
