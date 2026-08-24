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
 * command (not just the program) so `meridian doctor --json` works as well
 * as `meridian --json doctor`.
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
    .name('meridian')
    .description('One command to set up every AI coding tool on any machine.')
    .version(VERSION, '-v, --version', 'show the installed Meridian version')
    .showSuggestionAfterError(true)
    .showHelpAfterError(pc.dim('(run meridian --help for a list of commands)'))
    .addHelpText(
      'after',
      `
Examples:
  $ meridian                            open the interactive menu
  $ meridian doctor                     check which AI tools are installed
  $ meridian install claude             install & configure Claude Code
  $ meridian install                    pick a tool from an interactive list
  $ meridian auth anthropic             store your Anthropic API key securely
  $ meridian generate                   make this project AI-ready in one shot
  $ meridian mcp search github          find MCP servers
  $ meridian ask "explain this repo"    ask AI (auto-picks the best provider)`,
    );

  program
    .command('doctor')
    .alias('dr')
    .description('Check tools, providers, key vault and this project’s AI kit')
    .option('--online', 'also verify each stored API key against its provider (costs no tokens)')
    .addHelpText(
      'after',
      '\nOffline and read-only by default. Always exits 0 — parse --json to gate a script,\nor use "meridian sync --check", which is built to fail a build.',
    )
    .action(async (opts: { online?: boolean }) => done(await doctorCommand(opts)));

  program
    .command('install [tool]')
    .alias('i')
    .description('Install and configure a tool ("all" for everything; omit for a picker)')
    .addHelpText(
      'after',
      '\nExamples:\n  $ meridian install claude\n  $ meridian install all\n  $ meridian install            (interactive picker)',
    )
    .action(async (tool?: string) => done(await installCommand(tool)));

  program
    .command('uninstall [tool]')
    .description('Uninstall a tool managed by Meridian (omit for a picker)')
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
    .option(
      '--tools <ids>',
      'comma-separated tools to write instruction files for, or "all" (default: detected)',
    )
    .option(
      '--rigor <level>',
      'working-agreement strictness: light, standard or strict (default: standard)',
    )
    .option('--no-ai', 'use static templates even if an AI provider is configured')
    .addHelpText(
      'after',
      '\nKinds: rules, agents, skills, commands, prompts, docs, harness (default: all)\nRigour: light (read-before-write + no silent doc edits), standard (default), strict (full agreement)\nTools: claude, cursor, codex, copilot, gemini (default: the ones detected for this project)\nOpt-in kinds (only when named): ci — a GitHub Action running "meridian sync --check"\nExamples:\n  $ meridian generate                   generate everything\n  $ meridian generate agents commands   only subagents and slash commands\n  $ meridian generate ci                add the CI kit-freshness check\n  $ meridian generate --estimate        what it would cost, before spending\n  $ meridian generate --dry-run         preview without writing\n  $ meridian generate --rigor light     a kit that gets out of the way\n  $ meridian generate --tools claude    only write CLAUDE.md',
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
          rigor?: string;
          tools?: string;
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
      '\nHand-edited generated files are always preserved.\nExamples:\n  $ meridian sync                       refresh whatever is stale\n  $ meridian sync --check               CI gate: fail when the kit is stale',
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
      '\nThe answer streams as it arrives on a terminal, and is buffered when piped.\nPiped input becomes context:\n  $ cat error.log | meridian ask "what failed here?"',
    )
    .action(async (prompt: string[], opts: { provider?: string; model?: string }) =>
      done(await askCommand(prompt ?? [], opts)),
    );

  program
    .command('router')
    .description('Configure the AI router')
    .option('--prefer <provider>', 'always prefer this provider (empty to clear)')
    .option('--optimize <metric>', 'optimize for cost, speed or quality')
    .option(
      '--model <provider> [model...]',
      'set the model for a provider (omit the model to restore its default)',
    )
    .addHelpText(
      'after',
      '\n"meridian generate" asks which model to use the first time it runs against a\nprovider and remembers the answer — this is how you change it afterwards.\nExamples:\n  $ meridian router --model anthropic claude-opus-5\n  $ meridian router --model anthropic          restore the default model\n  $ meridian router --prefer ollama            always route to a local model',
    )
    .action((opts: { prefer?: string; optimize?: string; model?: string[] }) =>
      done(routerConfigCommand(opts)),
    );

  program
    .command('update')
    .description('Update the Meridian CLI and installed tools')
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
