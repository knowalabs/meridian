import pc from 'picocolors';
import { currentLevel, jsonMode } from './logger.js';

/**
 * Minimal progress spinner on stderr: animated with elapsed time on a TTY,
 * one plain line per phase otherwise (CI logs), silent under --quiet/--json.
 * stderr keeps stdout clean for piped output.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLEAR_LINE = '\r\x1b[2K';

export interface Spinner {
  /** Swap the label while keeping the same elapsed clock. */
  update(label: string): void;
  succeed(message?: string): void;
  fail(message?: string): void;
}

export function startSpinner(label: string): Spinner {
  const silent = currentLevel() === 'quiet' || jsonMode();
  const animated = !silent && process.stderr.isTTY === true;
  const started = Date.now();
  let current = label;
  let frame = 0;

  const elapsed = (): string => `${Math.round((Date.now() - started) / 1000)}s`;
  const render = (): void => {
    process.stderr.write(
      `${CLEAR_LINE}${pc.cyan(FRAMES[frame++ % FRAMES.length] ?? '')} ${current} ${pc.dim(elapsed())}`,
    );
  };

  let timer: NodeJS.Timeout | null = null;
  if (animated) {
    render();
    timer = setInterval(render, 100);
    timer.unref();
  } else if (!silent) {
    process.stderr.write(pc.dim(`${current}\n`));
  }

  const finish = (symbol: string, message?: string): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      process.stderr.write(CLEAR_LINE);
    }
    if (!silent)
      process.stderr.write(`${symbol} ${message ?? current} ${pc.dim(`(${elapsed()})`)}\n`);
  };

  return {
    update(l: string): void {
      current = l;
      if (!silent && !animated) process.stderr.write(pc.dim(`${l}\n`));
    },
    succeed(m?: string): void {
      finish(pc.green('✔'), m);
    },
    fail(m?: string): void {
      finish(pc.red('✖'), m);
    },
  };
}
