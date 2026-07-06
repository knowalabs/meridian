#!/usr/bin/env node
import { buildCli } from './cli.js';
import { runInteractive, showWelcome } from './launcher.js';

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    // Bare `devpilot`: interactive menu in a terminal, static overview otherwise.
    if (process.stdin.isTTY && process.stdout.isTTY) await runInteractive();
    else showWelcome();
    return;
  }
  await buildCli().parseAsync(process.argv);
}

void main();
