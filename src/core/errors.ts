import pc from 'picocolors';

/** Exit codes used across the CLI (BSD sysexits where they fit). */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  UNAVAILABLE: 69,
  SIGINT: 130,
} as const;

export interface CliErrorOptions {
  exitCode?: number;
  /** Actionable next step shown under the error, e.g. "run knowa auth anthropic". */
  hint?: string;
  cause?: unknown;
}

/**
 * An expected, user-facing failure. Anything else that escapes to the
 * top-level boundary is treated as a bug.
 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, opts: CliErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CliError';
    this.exitCode = opts.exitCode ?? EXIT.ERROR;
    this.hint = opts.hint;
  }
}

function causeChain(err: unknown): string[] {
  const lines: string[] = [];
  let current: unknown = err;
  while (current instanceof Error && current.cause !== undefined) {
    current = current.cause;
    lines.push(current instanceof Error ? (current.stack ?? current.message) : String(current));
  }
  return lines;
}

/** Print an error for the user and return the exit code to use. */
export function renderError(err: unknown, opts: { verbose?: boolean } = {}): number {
  const verbose = opts.verbose ?? false;
  if (err instanceof CliError) {
    console.error(`${pc.red('✖')} ${err.message}`);
    if (err.hint) console.error(pc.dim(`  ${err.hint}`));
    if (verbose) {
      if (err.stack) console.error(pc.dim(err.stack));
      for (const cause of causeChain(err)) console.error(pc.dim(`caused by: ${cause}`));
    }
    return err.exitCode;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(`${pc.red('✖')} Unexpected error: ${message}`);
  if (verbose && err instanceof Error && err.stack) {
    console.error(pc.dim(err.stack));
    for (const cause of causeChain(err)) console.error(pc.dim(`caused by: ${cause}`));
  } else {
    console.error(pc.dim('  This looks like a bug in Knowa. Re-run with --verbose for details.'));
  }
  return EXIT.ERROR;
}
