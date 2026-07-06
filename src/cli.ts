import { Command } from 'commander';
import pc from 'picocolors';
import { doctorCommand } from './commands/doctor.js';
import { installCommand, uninstallCommand } from './commands/install.js';
import { authCommand, keysListCommand, keysRemoveCommand } from './commands/auth.js';
import { initCommand } from './commands/init.js';
import { scanCommand } from './commands/scan.js';
import { rulesGenerateCommand, rulesListCommand } from './commands/rules.js';
import {
  mcpInstallCommand,
  mcpListCommand,
  mcpRemoveCommand,
  mcpSearchCommand,
} from './commands/mcp.js';
import { askCommand, routerConfigCommand } from './commands/ask.js';
import { loginCommand, updateCommand } from './commands/update.js';
import { ensureHome } from './core/paths.js';

export const VERSION = '0.3.0';

export interface CliOptions {
  /** Throw CommanderError instead of exiting — used by the interactive launcher. */
  exitOverride?: boolean;
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
  $ devpilot init && devpilot scan      make this project AI-ready
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
    .addHelpText('after', '\nExamples:\n  $ devpilot install claude\n  $ devpilot install all\n  $ devpilot install            (interactive picker)')
    .action(async (tool?: string) => done(await installCommand(tool)));

  program
    .command('uninstall [tool]')
    .description('Uninstall a tool managed by DevPilot (omit for a picker)')
    .action(async (tool?: string) => done(await uninstallCommand(tool)));

  program
    .command('auth [provider] [key]')
    .description('Store an API key in the secure vault (openai, anthropic, google, openrouter)')
    .addHelpText('after', '\nThe key is prompted with hidden input — you rarely need to pass it as an argument.')
    .action(async (provider?: string, key?: string) => done(await authCommand(provider, key)));

  const keys = program.command('keys').description('Manage stored API keys');
  keys.command('list').alias('ls').description('List stored API keys (masked)').action(() => done(keysListCommand()));
  keys
    .command('remove <provider>')
    .alias('rm')
    .description('Delete a stored API key')
    .action((provider: string) => done(keysRemoveCommand(provider)));

  program
    .command('init')
    .description('Create an AI-ready project scaffold (.devpilot/, CLAUDE.md, AGENTS.md, README_AI.md)')
    .action(() => done(initCommand()));

  program
    .command('scan')
    .description('Analyze the project and generate AI context files')
    .action(() => done(scanCommand()));

  const rules = program.command('rules').description('Generate AI tool instruction files');
  rules
    .command('generate [targets...]')
    .alias('gen')
    .description('Generate instruction files for Claude, Cursor, Codex, Copilot, Gemini')
    .action((targets: string[]) => done(rulesGenerateCommand(targets ?? [])));
  rules.command('list').alias('ls').description('List supported rule targets').action(() => done(rulesListCommand()));

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
  mcp.command('list').alias('ls').description('List installed MCP servers').action(() => done(mcpListCommand()));

  program
    .command('ask [prompt...]')
    .description('Ask AI — routed to the best provider (cost/speed/quality aware)')
    .option('-p, --provider <id>', 'force a specific provider')
    .action(async (prompt: string[], opts: { provider?: string }) =>
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
    .description('Sign in for Cloud Sync (coming in v0.4)')
    .action(() => done(loginCommand()));

  return program;
}
