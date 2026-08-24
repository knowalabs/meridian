#!/usr/bin/env node
// colorflag must be first: it turns --no-color into NO_COLOR before
// picocolors (imported by nearly every other module) decides color support.
import './core/colorflag.js';
import { renderError, EXIT } from './core/errors.js';
import { buildCli } from './cli.js';
import { runInteractive, showWelcome } from './launcher.js';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(
    `meridian requires Node.js 18 or newer (you are running ${process.versions.node}).`,
  );
  process.exit(EXIT.UNAVAILABLE);
}

const verbose = process.argv.includes('--verbose');

process.on('uncaughtException', (err) => {
  process.exit(renderError(err, { verbose }));
});
process.on('unhandledRejection', (err) => {
  process.exit(renderError(err, { verbose }));
});
process.on('SIGINT', () => {
  // Restore the terminal in case the interactive launcher was active.
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?25h\n');
  process.exit(EXIT.SIGINT);
});

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    // Bare `meridian`: interactive menu in a terminal, static overview otherwise.
    if (process.stdin.isTTY && process.stdout.isTTY) await runInteractive();
    else showWelcome();
    return;
  }
  await buildCli().parseAsync(process.argv);
}

main().catch((err: unknown) => {
  process.exitCode = renderError(err, { verbose });
});
