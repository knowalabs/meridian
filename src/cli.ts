import { Command } from 'commander';
import pc from 'picocolors';
import { configureLogger } from './core/logger.js';
import { VERSION } from './core/pkg.js';
import { doctorCommand } from './commands/doctor.js';
import { installCommand, uninstallCommand } from './commands/install.js';
import {
  authCommand,
  keysListCommand,
  keysRemoveCommand,
  keysRepairCommand,
} from './commands/auth.js';
import { generateCommand } from './commands/generate.js';
import { syncCommand } from './commands/sync.js';
import {
  mcpInstallCommand,
  mcpListCommand,
  mcpRemoveCommand,
  mcpSearchCommand,
} from './commands/mcp.js';
import { askCommand, routerConfigCommand } from './commands/ask.js';
import { loginCommand, updateCommand } from './commands/update.js';
import { ensureHome } from './core/paths.js';

export { VERSION };

export interface CliOptions {
  /** Throw CommanderError instead of exiting — used by the interactive launcher. */
  exitOverride?: boolean;
}

interface GlobalFlags {
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  color?: boolean;
}

/**
 * Register the global output flags on a command. They live on every leaf
 * command (not just the program) so `devpilot doctor --json` works as well
 * as `devpilot --json doctor`.
 */
function addGlobalFlags(cmd: Command): void {
  cmd
    .option('--verbose', 'show debug output and stack traces')
    .option('-q, --quiet', 'only print errors')
    .option('--json', 'output machine-readable JSON (where supported)')
    .option('--no-color', 'disable colored output');
  for (const sub of cmd.commands) addGlobalFlags(sub);
}

export function buildCli(options: CliOptions = {}): Command {
  ensureHome();
  const program = new Command();

  // Actions set process.exitCode instead of calling process.exit() so the
  // interactive launcher can run commands in-process and keep going.
  const done = (code: number): void => {
    process.exitCode = code;
  };

  if (options.exitOverride) program.exitOverride();

  program
    .name('devpilot')
    .description('One command to set up every AI coding tool on any machine.')
    .version(VERSION, '-v, --version', 'show the installed DevPilot version')
    .showSuggestionAfterError(true)
    .showHelpAfterError(pc.dim('(run devpilot --help for a list of commands)'))
    .addHelpText(
      'after',
      `
Examples:
  $ devpilot                            open the interactive menu
  $ devpilot doctor                     check which AI tools are installed
  $ devpilot install claude             install & configure Claude Code
  $ devpilot install                    pick a tool from an interactive list
  $ devpilot auth anthropic             store your Anthropic API key securely
  $ devpilot generate                   make this project AI-ready in one shot
  $ devpilot mcp search github          find MCP servers
  $ devpilot ask "explain this repo"    ask AI (auto-picks the best provider)`,
    );

  program
    .command('doctor')
    .alias('dr')
    .description('Detect installed AI tools and missing dependencies')
    .action(() => done(doctorCommand()));

  program
    .command('install [tool]')
    .alias('i')
    .description('Install and configure a tool ("all" for everything; omit for a picker)')
    .addHelpText(
      'after',
      '\nExamples:\n  $ devpilot install claude\n  $ devpilot install all\n  $ devpilot install            (interactive picker)',
    )
    .action(async (tool?: string) => done(await installCommand(tool)));

  program
    .command('uninstall [tool]')
    .description('Uninstall a tool managed by DevPilot (omit for a picker)')
    .action(async (tool?: string) => done(await uninstallCommand(tool)));

  program
    .command('auth [provider] [key]')
    .description('Store an API key in the secure vault (run without arguments to pick a provider)')
    .option('--no-verify', 'store the key without checking it against the provider')
    .addHelpText(
      'after',
      '\nThe key is prompted with hidden input — you rarely need to pass it as an argument.\nKeys are verified against the provider before storing (skip with --no-verify).',
    )
    .action(
      async (provider: string | undefined, key: string | undefined, opts: { verify?: boolean }) =>
        done(await authCommand(provider, key, opts)),
    );

  const keys = program.command('keys').description('Manage stored API keys');
  keys
    .command('list')
    .alias('ls')
    .description('List stored API keys (masked)')
    .action(() => done(keysListCommand()));
  keys
    .command('remove <provider>')
    .alias('rm')
    .description('Delete a stored API key')
    .action((provider: string) => done(keysRemoveCommand(provider)));
  keys
    .command('repair')
    .description('Back up and reinitialize a corrupted key vault')
    .action(() => done(keysRepairCommand()));

  program
    .command('generate [kinds...]')
    .alias('gen')
    .description(
      'Review the codebase and generate everything AI tools need: context, rules, subagents, skills, slash commands, prompts, docs',
    )
    .option('-p, --provider <id>', 'force a specific AI provider')
    .option('-f, --force', 'overwrite existing files')
    .option('--dry-run', 'show what would be generated without writing')
    .option('--estimate', 'report tokens, AI calls and rough cost — makes no AI call')
    .option('-m, --model <model>', 'model to use, overriding the provider default')
    .option('--concurrency <n>', 'artifact kinds to generate at once (default: per provider)')
    .option('--no-cache', 'ignore the cached codebase review and read the project again')
    .option('--no-ai', 'use static templates even if an AI provider is configured')
    .addHelpText(
      'after',
      '\nKinds: rules, agents, skills, commands, prompts, docs, harness (default: all)\nOpt-in kinds (only when named): ci — a GitHub Action running "devpilot sync --check"\nExamples:\n  $ devpilot generate                   generate everything\n  $ devpilot generate agents commands   only subagents and slash commands\n  $ devpilot generate ci                add the CI kit-freshness check\n  $ devpilot generate --estimate        what it would cost, before spending\n  $ devpilot generate --dry-run         preview without writing',
    )
    .action(
      async (
        kinds: string[],
        opts: {
          provider?: string;
          force?: boolean;
          dryRun?: boolean;
          ai?: boolean;
          estimate?: boolean;
          concurrency?: string;
          cache?: boolean;
          model?: string;
        },
      ) => done(await generateCommand(kinds ?? [], opts)),
    );

  program
    .command('sync')
    .description('Detect drift between the codebase and the generated AI kit, and refresh it')
    .option('--check', 'report only; exit 1 when the kit is stale (no AI needed — made for CI)')
    .option('-p, --provider <id>', 'force a specific AI provider for the refresh')
    .option('--dry-run', 'show what would be refreshed without writing')
    .option('--concurrency <n>', 'artifact kinds to refresh at once (default: per provider)')
    .option('-m, --model <model>', 'model to use, overriding the provider default')
    .option('--no-cache', 'ignore the cached codebase review and read the project again')
    .option('--no-ai', 'refresh from static templates instead of AI')
    .addHelpText(
      'after',
      '\nHand-edited generated files are always preserved.\nExamples:\n  $ devpilot sync                       refresh whatever is stale\n  $ devpilot sync --check               CI gate: fail when the kit is stale',
    )
    .action(
      async (opts: {
        check?: boolean;
        provider?: string;
        dryRun?: boolean;
        ai?: boolean;
        concurrency?: string;
        cache?: boolean;
        model?: string;
      }) => done(await syncCommand(opts)),
    );

  const mcp = program.command('mcp').description('Search and install MCP servers');
  mcp
    .command('search [query]')
    .description('Search the MCP server registry')
    .action((query?: string) => done(mcpSearchCommand(query)));
  mcp
    .command('install <id>')
    .alias('i')
    .description('Install an MCP server into all detected AI tools')
    .action((id: string) => done(mcpInstallCommand(id)));
  mcp
    .command('remove <id>')
    .alias('rm')
    .description('Remove an MCP server from all configs')
    .action((id: string) => done(mcpRemoveCommand(id)));
  mcp
    .command('list')
    .alias('ls')
    .description('List installed MCP servers')
    .action(() => done(mcpListCommand()));

  program
    .command('ask [prompt...]')
    .description('Ask AI — routed to the best provider (cost/speed/quality aware)')
    .option('-p, --provider <id>', 'force a specific provider')
    .option('-m, --model <model>', 'model to use for this question')
    .addHelpText(
      'after',
      '\nThe answer streams as it arrives on a terminal, and is buffered when piped.\nPiped input becomes context:\n  $ cat error.log | devpilot ask "what failed here?"',
    )
    .action(async (prompt: string[], opts: { provider?: string; model?: string }) =>
      done(await askCommand(prompt ?? [], opts)),
    );

  program
    .command('router')
    .description('Configure the AI router')
    .option('--prefer <provider>', 'always prefer this provider (empty to clear)')
    .option('--optimize <metric>', 'optimize for cost, speed or quality')
    .action((opts: { prefer?: string; optimize?: string }) => done(routerConfigCommand(opts)));

  program
    .command('update')
    .description('Update the DevPilot CLI and installed tools')
    .option('--self', 'only update the CLI')
    .option('--tools', 'only update installed tools')
    .action(async (opts: { self?: boolean; tools?: boolean }) => done(await updateCommand(opts)));

  program
    .command('login')
    .description('Sign in for Cloud Sync (not available yet)')
    .action(() => done(loginCommand()));

  addGlobalFlags(program);
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const flags = actionCommand.optsWithGlobals<GlobalFlags>();
    configureLogger({
      level: flags.verbose ? 'verbose' : flags.quiet ? 'quiet' : 'normal',
      json: flags.json ?? false,
    });
  });

  return program;
}
