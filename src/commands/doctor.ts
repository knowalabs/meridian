import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { buildRegistry } from '../plugins/tools.js';
import {
  availableProviders,
  modelFor,
  PROVIDERS,
  route,
  verifyApiKey,
  type KeyVerification,
} from '../providers/router.js';
import { openVault, type VaultBackend } from '../core/vault.js';
import { meridianHome, globalConfigPath } from '../core/paths.js';
import { readJsonFile } from '../core/fsx.js';
import { diffFingerprints, fileStates, fingerprintOf, readManifest } from '../generate/manifest.js';
import { analyzeProject } from '../scan/analyzer.js';
import { VERSION } from '../core/pkg.js';
import { jsonMode, log } from '../core/logger.js';

/**
 * `meridian doctor` — the first command a new user runs, so it answers the
 * questions that actually block people: which AI tools are installed, which
 * providers `generate`/`ask` can use *right now* and which one they would
 * pick, whether the key vault is readable, and whether this project's kit is
 * still in sync. Every failure carries the command that fixes it.
 *
 * Read-only and offline by default — no AI call, no network — so it is safe
 * to run anywhere. `--online` additionally checks stored keys against their
 * provider, which costs no tokens.
 *
 * The exit code stays 0 even when checks fail: a missing tool or an
 * unconfigured provider is a normal state, not a broken machine. Scripts that
 * need to gate on the result read `--json` (or use `meridian sync --check`,
 * which exists to fail a build).
 */

const MINIMUM_NODE_MAJOR = 18;

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  label: string;
  level: Level;
  detail: string;
  /** The command or action that resolves this check, when one exists. */
  fix?: string;
}

interface ToolStatus {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  hint: string | null;
}

interface ProviderStatus {
  id: string;
  name: string;
  model: string;
  ready: boolean;
  /** Why it is unusable, when it is not ready. */
  blockedBy: string | null;
  /** Set only when `--online` checked the stored key against the provider. */
  keyCheck?: KeyVerification;
}

interface KitStatus {
  root: string;
  present: boolean;
  generatedAt: string | null;
  generatedBy: string | null;
  drift: string[];
  missing: string[];
  edited: string[];
}

export interface DoctorReportJson {
  meridian: string;
  environment: Check[];
  tools: ToolStatus[];
  missing: number;
  providers: ProviderStatus[];
  /** Provider `generate` and `ask` would route to today, if any. */
  routesTo: string | null;
  vault: { backend: VaultBackend | null; keys: string[]; unreadable: string[] };
  kit: KitStatus;
}

/* --------------------------------- checks --------------------------------- */

function environmentChecks(): Check[] {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    major >= MINIMUM_NODE_MAJOR
      ? { label: 'Node.js', level: 'ok', detail: `v${process.versions.node}` }
      : {
          label: 'Node.js',
          level: 'fail',
          detail: `v${process.versions.node} — Meridian needs v${MINIMUM_NODE_MAJOR} or newer`,
          fix: 'https://nodejs.org/en/download',
        },
  );

  // The home is created on demand, so "not there yet" is not a fault — what
  // matters is whether it could be written. Doctor never creates it itself.
  const home = meridianHome();
  const target = fs.existsSync(home) ? home : path.dirname(home);
  try {
    fs.accessSync(target, fs.constants.W_OK);
    checks.push({
      label: 'Meridian home',
      level: 'ok',
      detail: target === home ? home : `${home} (will be created on first use)`,
    });
  } catch {
    checks.push({
      label: 'Meridian home',
      level: 'fail',
      detail: `${home} is not writable`,
      fix: `check the permissions on ${target}`,
    });
  }

  const configFile = globalConfigPath();
  const config = readJsonFile<unknown>(configFile);
  if (config.ok) {
    checks.push({ label: 'Config', level: 'ok', detail: configFile });
  } else if (config.reason === 'missing') {
    checks.push({ label: 'Config', level: 'ok', detail: 'using defaults (no config file yet)' });
  } else {
    checks.push({
      label: 'Config',
      level: 'warn',
      detail: `${configFile} is not valid JSON and is being ignored`,
      fix: `fix or delete ${configFile}`,
    });
  }

  return checks;
}

function toolStatuses(): ToolStatus[] {
  return buildRegistry()
    .all()
    .map((plugin) => {
      const report = plugin.doctor();
      return {
        id: plugin.id,
        name: plugin.name,
        installed: report.installed,
        version: report.version ?? null,
        hint: report.hint ?? null,
      };
    });
}

/** Vault reads must never take the whole command down. */
function safeVaultKeys(): string[] {
  try {
    return openVault().list();
  } catch {
    return [];
  }
}

function providerStatuses(available: string[]): ProviderStatus[] {
  const stored = new Set(safeVaultKeys());
  return PROVIDERS.map((p) => {
    const ready = available.includes(p.id);
    let blockedBy: string | null = null;
    if (!ready) {
      if (p.needsKey && !stored.has(p.id)) blockedBy = 'no API key stored';
      else if (p.binary) blockedBy = `the "${p.binary}" CLI is not on PATH`;
      else blockedBy = 'disabled via MERIDIAN_DISABLE_PROVIDERS';
    }
    return { id: p.id, name: p.name, model: modelFor(p), ready, blockedBy };
  });
}

function vaultStatus(): DoctorReportJson['vault'] {
  try {
    const vault = openVault();
    const keys = vault.list();
    const unreadable = keys.filter((account) => {
      try {
        return !vault.get(account);
      } catch {
        return true;
      }
    });
    return { backend: vault.backend, keys, unreadable };
  } catch {
    return { backend: null, keys: [], unreadable: [] };
  }
}

function kitStatus(cwd: string): KitStatus {
  const manifest = readManifest(cwd);
  if (!manifest) {
    return {
      root: cwd,
      present: false,
      generatedAt: null,
      generatedBy: null,
      drift: [],
      missing: [],
      edited: [],
    };
  }
  const states = fileStates(cwd, manifest);
  return {
    root: cwd,
    present: true,
    generatedAt: manifest.generatedAt,
    generatedBy: manifest.meridian,
    drift: diffFingerprints(manifest.fingerprint, fingerprintOf(analyzeProject(cwd))),
    missing: states.missing,
    edited: states.edited,
  };
}

/* -------------------------------- rendering -------------------------------- */

const MARK: Record<Level, string> = {
  ok: pc.green('✔'),
  warn: pc.yellow('△'),
  fail: pc.red('✖'),
};

function line(level: Level, label: string, detail: string, fix?: string): void {
  const body = `${MARK[level]} ${label.padEnd(14)} ${detail}`;
  log.info(fix ? `${body} ${pc.dim(`→ ${fix}`)}` : body);
}

const KEY_CHECK_NOTE: Record<KeyVerification, { level: Level; text: string }> = {
  valid: { level: 'ok', text: 'key accepted' },
  invalid: { level: 'fail', text: 'key rejected by the provider' },
  unreachable: { level: 'warn', text: 'could not reach the provider' },
};

function render(report: DoctorReportJson): void {
  log.title(
    `Meridian ${report.meridian} — ${process.platform} ${process.arch}, node ${process.versions.node}\n`,
  );

  log.info(pc.bold('Environment'));
  for (const c of report.environment) line(c.level, c.label, c.detail, c.fix);

  log.info(`\n${pc.bold('AI tools')}`);
  for (const tool of report.tools) {
    if (tool.installed) line('ok', tool.name, pc.dim(tool.version ?? ''));
    else line('fail', tool.name, 'not found', tool.hint ? `install: ${tool.hint}` : undefined);
  }

  log.info(`\n${pc.bold('AI providers')} ${pc.dim('— what generate and ask can use right now')}`);
  for (const p of report.providers.filter((x) => x.ready)) {
    const notes = [pc.dim(`[${p.model}]`)];
    if (p.id === report.routesTo) notes.push(pc.cyan('← routes here by default'));
    if (p.keyCheck) {
      const note = KEY_CHECK_NOTE[p.keyCheck];
      notes.push(note.level === 'ok' ? pc.dim(note.text) : `${MARK[note.level]} ${note.text}`);
    }
    line(p.keyCheck === 'invalid' ? 'fail' : 'ok', p.id, notes.join(' '));
  }

  // The unconfigured ones are the long tail — a dozen identical "no API key"
  // lines bury the providers that actually work. One line per reason instead.
  const needKey = report.providers.filter((p) => !p.ready && p.blockedBy?.includes('API key'));
  const needCli = report.providers.filter((p) => !p.ready && p.blockedBy?.includes('CLI'));
  const otherwiseOff = report.providers.filter(
    (p) => !p.ready && !needKey.includes(p) && !needCli.includes(p),
  );
  if (needKey.length) {
    line('warn', 'need a key', needKey.map((p) => p.id).join(', '), 'meridian auth <provider>');
  }
  if (needCli.length) {
    line(
      'warn',
      'need a CLI',
      needCli.map((p) => p.id).join(', '),
      'install it — a signed-in AI CLI works with no API key',
    );
  }
  if (otherwiseOff.length) {
    line(
      'warn',
      'disabled',
      otherwiseOff.map((p) => p.id).join(', '),
      'MERIDIAN_DISABLE_PROVIDERS',
    );
  }
  if (!report.routesTo) {
    log.info(
      `  ${pc.dim('No provider configured — generate and ask need one. Sign in to an AI CLI or run')} ${pc.bold('meridian auth')}${pc.dim('.')}`,
    );
  }

  log.info(`\n${pc.bold('Key vault')}`);
  if (!report.vault.backend) {
    line('fail', 'vault', 'could not be opened', 'meridian keys repair');
  } else {
    line(
      'ok',
      report.vault.backend,
      report.vault.keys.length
        ? `${report.vault.keys.length} key(s): ${report.vault.keys.join(', ')}`
        : 'no keys stored',
    );
    if (report.vault.unreadable.length) {
      line(
        'fail',
        'unreadable',
        report.vault.unreadable.join(', '),
        'meridian keys repair (backs up first)',
      );
    }
  }

  log.info(`\n${pc.bold('Project kit')} ${pc.dim(report.kit.root)}`);
  renderKit(report.kit);
}

function renderKit(kit: KitStatus): void {
  if (!kit.present) {
    const legacy = fs.existsSync(path.join(kit.root, '.meridian'));
    line(
      'warn',
      'kit',
      legacy
        ? 'generated before kit manifests existed — sync cannot track it'
        : 'no AI kit in this project yet',
      'meridian generate',
    );
    return;
  }
  line('ok', 'generated', `${kit.generatedAt} by meridian ${kit.generatedBy}`);
  if (kit.drift.length || kit.missing.length) {
    line(
      'warn',
      'freshness',
      `stale — ${kit.drift.length} drift signal(s), ${kit.missing.length} file(s) deleted`,
      'meridian sync',
    );
    for (const d of kit.drift.slice(0, 5)) log.info(`    ${pc.dim(d)}`);
    if (kit.drift.length > 5) log.info(`    ${pc.dim(`… and ${kit.drift.length - 5} more`)}`);
  } else {
    line('ok', 'freshness', 'in sync with the codebase');
  }
  if (kit.edited.length) {
    line('ok', 'hand edits', `${kit.edited.length} file(s) — sync will preserve them`);
  }
}

/** The most useful next steps, printed last so they are what people see. */
function renderNextSteps(report: DoctorReportJson): void {
  const steps: string[] = [];
  if (report.environment.some((c) => c.level === 'fail')) {
    steps.push('fix the environment problems above — nothing else will work reliably');
  }
  if (!report.routesTo) steps.push(`${pc.bold('meridian auth')} — or sign in to an AI CLI`);
  if (report.vault.unreadable.length) steps.push(pc.bold('meridian keys repair'));
  if (!report.kit.present) {
    steps.push(`${pc.bold('meridian generate')} — make this project AI-ready`);
  } else if (report.kit.drift.length || report.kit.missing.length) {
    steps.push(`${pc.bold('meridian sync')} — the kit is behind the code`);
  }
  if (report.providers.some((p) => p.keyCheck === 'invalid')) {
    steps.push(`${pc.bold('meridian auth <provider>')} — a stored key was rejected`);
  }
  if (report.missing) {
    steps.push(`${pc.bold('meridian install all')} — ${report.missing} tool(s) missing`);
  }

  log.info('');
  if (steps.length === 0) {
    log.ok('Everything checks out.');
    return;
  }
  log.info(pc.bold('Next steps'));
  for (const step of steps) log.info(`  • ${step}`);
}

/* --------------------------------- command --------------------------------- */

export async function doctorCommand(
  opts: { online?: boolean } = {},
  cwd: string = process.cwd(),
): Promise<number> {
  const available = availableProviders();
  const providers = providerStatuses(available);
  const vault = vaultStatus();

  if (opts.online) {
    // Tokenless authenticated GETs — run them together, never one after another.
    await Promise.all(
      providers
        .filter((p) => p.ready && vault.keys.includes(p.id))
        .map(async (p) => {
          p.keyCheck = await verifyApiKey(p.id, openVault().get(p.id) ?? '');
        }),
    );
  }

  const tools = toolStatuses();
  const report: DoctorReportJson = {
    meridian: VERSION,
    environment: environmentChecks(),
    tools,
    missing: tools.filter((t) => !t.installed).length,
    providers,
    routesTo: route('generate ai project artifacts', available)?.provider.id ?? null,
    vault,
    kit: kitStatus(cwd),
  };

  if (jsonMode()) {
    log.json(report);
    return 0;
  }

  render(report);
  renderNextSteps(report);
  return 0;
}
