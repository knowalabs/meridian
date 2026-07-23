import readline from 'node:readline';
import pc from 'picocolors';
import { CommanderError } from 'commander';
import { buildCli, VERSION } from './cli.js';
import { renderError } from './core/errors.js';

/* ---------------------------------- banner ---------------------------------- */

const LETTERS: Record<string, string[]> = {
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  V: ['██╗   ██╗', '██║   ██║', '██║   ██║', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚═══╝  '],
  P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  L: ['██╗     ', '██║     ', '██║     ', '██║     ', '███████╗', '╚══════╝'],
  O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
};

function bannerRows(word: string): string[] {
  return Array.from({ length: 6 }, (_, row) =>
    word
      .split('')
      .map((ch) => LETTERS[ch]?.[row] ?? '')
      .join(''),
  );
}

export function showBanner(): void {
  const wide = (process.stdout.columns ?? 80) >= 68;
  console.log('');
  if (wide) {
    for (const row of bannerRows('DEVPILOT')) console.log(`  ${pc.cyan(row)}`);
  } else {
    console.log(`  ${pc.cyan(pc.bold('✈ DevPilot'))}`);
  }
  console.log(
    `\n  ${pc.bold('One command to set up every AI coding tool.')} ${pc.dim(`v${VERSION}`)}\n`,
  );
}

/** Static overview for non-interactive terminals (pipes, CI). */
export function showWelcome(): void {
  const row = (cmd: string, what: string) => `  ${pc.cyan(cmd.padEnd(28))} ${what}`;
  console.log(`
${pc.bold(`DevPilot ${pc.dim(`v${VERSION}`)}`)} — one command to set up every AI coding tool.

${pc.bold('Get started:')}
${row('devpilot doctor', 'see which AI tools are installed')}
${row('devpilot install', 'install tools (interactive picker)')}
${row('devpilot auth', 'store an API key in the secure vault')}
${row('devpilot generate', 'make your project AI-ready in one shot')}

${pc.bold('Everyday:')}
${row('devpilot ask "…"', 'ask AI via the smart router')}
${row('devpilot mcp search', 'find & install MCP servers')}

Run ${pc.bold('devpilot --help')} for all commands, or ${pc.bold('devpilot <command> --help')} for details.`);
}

/* ----------------------------------- menu ----------------------------------- */

interface MenuItem {
  /** devpilot subcommand line this item runs. */
  command: string;
  label: string;
  description: string;
  /** Enter drops the command into the input line instead of running it. */
  needsArgs?: boolean;
}

const QUIT = '__quit';

const MENU: MenuItem[] = [
  { command: 'doctor', label: 'Doctor', description: 'check which AI tools are installed' },
  { command: 'install', label: 'Install tools', description: 'install & configure AI tools' },
  { command: 'auth', label: 'Add API key', description: 'store a key in the secure vault' },
  { command: 'keys list', label: 'List keys', description: 'show stored API keys (masked)' },
  {
    command: 'generate',
    label: 'Generate AI kit',
    description: 'review the codebase, generate context, rules, agents, skills, commands',
  },
  { command: 'mcp search', label: 'MCP servers', description: 'browse the MCP marketplace' },
  {
    command: 'ask',
    label: 'Ask AI',
    description: 'ask anything — routed to the best provider',
    needsArgs: true,
  },
  { command: 'update', label: 'Update', description: 'update the CLI and installed tools' },
  { command: 'help', label: 'Help', description: 'show all commands and options' },
  { command: QUIT, label: 'Quit', description: 'leave the menu (q or Esc)' },
];

/**
 * Arrow-key menu with a hybrid input line: typing filters the menu, and any
 * text that matches no item is run as a raw devpilot command on Enter.
 * Resolves with the chosen command line, or null to quit.
 */
function menuPrompt(): Promise<string | null> {
  return new Promise((resolve) => {
    const out = process.stdout;
    let selected = 0;
    let buffer = '';
    let rendered = 0;

    const visibleItems = (): MenuItem[] => {
      if (!buffer) return MENU;
      const q = buffer.toLowerCase();
      return MENU.filter(
        (m) => m.command !== QUIT && (m.command.startsWith(q) || m.label.toLowerCase().includes(q)),
      );
    };

    const render = (): void => {
      const items = visibleItems();
      if (selected >= items.length) selected = Math.max(0, items.length - 1);

      const lines: string[] = [];
      lines.push(
        `  ${pc.bold('What do you want to do?')}  ${pc.dim('↑↓ move · Enter run · type a command · q quit')}`,
      );
      lines.push('');
      for (const [i, item] of items.entries()) {
        const active = i === selected;
        const marker = active ? pc.cyan('❯') : ' ';
        const label = active ? pc.cyan(pc.bold(item.label.padEnd(16))) : item.label.padEnd(16);
        const cmd = item.command === QUIT ? '' : pc.dim(`devpilot ${item.command}`.padEnd(24));
        lines.push(`  ${marker} ${label} ${cmd} ${pc.dim(item.description)}`);
      }
      lines.push('');
      if (buffer && items.length === 0) {
        lines.push(
          `  ${pc.cyan('❯')} devpilot ${pc.bold(buffer)}${pc.cyan('▌')}  ${pc.dim('↵ run this command · Esc clear')}`,
        );
      } else if (buffer) {
        lines.push(
          `  ${pc.dim('>')} devpilot ${pc.bold(buffer)}${pc.cyan('▌')}  ${pc.dim('Tab complete · Esc clear')}`,
        );
      } else {
        lines.push(`  ${pc.dim('> start typing to filter or enter any command…')}`);
      }

      if (rendered > 0) {
        readline.moveCursor(out, 0, -rendered);
        readline.cursorTo(out, 0);
        readline.clearScreenDown(out);
      }
      out.write(lines.join('\n') + '\n');
      rendered = lines.length;
    };

    const finish = (value: string | null): void => {
      readline.moveCursor(out, 0, -rendered);
      readline.cursorTo(out, 0);
      readline.clearScreenDown(out);
      process.stdin.setRawMode(false);
      process.stdin.off('keypress', onKey);
      process.stdin.pause();
      out.write('\x1b[?25h'); // show cursor
      resolve(value);
    };

    const onKey = (str: string | undefined, key: readline.Key): void => {
      const items = visibleItems();

      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return finish(null);
      if (key.name === 'return' || key.name === 'enter') {
        if (buffer && items.length === 0) return finish(buffer);
        const item = items[selected];
        if (!item) return;
        if (item.command === QUIT) return finish(null);
        if (item.needsArgs) {
          buffer = `${item.command} `;
          selected = 0;
          return render();
        }
        return finish(item.command);
      }
      if (key.name === 'up') {
        if (items.length > 0) selected = (selected - 1 + items.length) % items.length;
        return render();
      }
      if (key.name === 'down') {
        if (items.length > 0) selected = (selected + 1) % items.length;
        return render();
      }
      if (key.name === 'tab') {
        const item = items[selected];
        if (item && item.command !== QUIT) {
          buffer = `${item.command} `;
          selected = 0;
        }
        return render();
      }
      if (key.name === 'escape') {
        if (!buffer) return finish(null);
        buffer = '';
        selected = 0;
        return render();
      }
      if (key.name === 'backspace') {
        buffer = buffer.slice(0, -1);
        return render();
      }
      if (!buffer && str === 'q') return finish(null);
      if (str && str >= ' ' && !key.ctrl && !key.meta) {
        buffer += str;
        selected = 0;
        return render();
      }
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    out.write('\x1b[?25l'); // hide cursor while navigating
    render();
  });
}

/* --------------------------------- execution --------------------------------- */

/** Split a command line into argv, honoring single/double quotes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  return tokens;
}

async function runCommandLine(line: string): Promise<number> {
  // Users may type the binary name out of habit — accept both forms.
  const argv = tokenize(line.replace(/^devpilot\s+/, ''));
  process.exitCode = 0;
  try {
    await buildCli({ exitOverride: true }).parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version output is not an error; anything else already printed a message.
      if (!err.code.startsWith('commander.help') && err.code !== 'commander.version') {
        process.exitCode = err.exitCode;
      }
    } else {
      // A failing command must never kill the menu loop.
      process.exitCode = renderError(err, { verbose: argv.includes('--verbose') });
    }
  }
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return code;
}

/** Banner + menu loop: run commands until the user quits. */
export async function runInteractive(): Promise<void> {
  showBanner();
  for (;;) {
    const line = await menuPrompt();
    if (line === null) {
      console.log(pc.dim('  Bye! Run devpilot anytime to come back.\n'));
      return;
    }
    console.log(`  ${pc.dim('$')} ${pc.bold(`devpilot ${line}`)}`);
    const code = await runCommandLine(line);
    console.log(
      code === 0 ? pc.dim('\n  ── done ──\n') : pc.yellow(`\n  ── exited with code ${code} ──\n`),
    );
  }
}
