import pc from 'picocolors';

export type LogLevel = 'quiet' | 'normal' | 'verbose';

let level: LogLevel = 'normal';
let json = false;

/** Configure output once per invocation (set from the global CLI flags). */
export function configureLogger(opts: { level?: LogLevel; json?: boolean }): void {
  if (opts.level) level = opts.level;
  if (opts.json !== undefined) json = opts.json;
}

/** True when --json was passed: commands should emit one JSON document. */
export function jsonMode(): boolean {
  return json;
}

export function currentLevel(): LogLevel {
  return level;
}

// Results and human reports go to stdout; warnings, errors and diagnostics go
// to stderr so piped output stays clean. --json silences human chatter on
// stdout entirely (the command prints its JSON document instead).
export const log = {
  /** Primary result output (stdout). */
  info(msg: string): void {
    if (level !== 'quiet' && !json) console.log(msg);
  },
  ok(msg: string): void {
    if (level !== 'quiet' && !json) console.log(`${pc.green('✔')} ${msg}`);
  },
  title(msg: string): void {
    if (level !== 'quiet' && !json) console.log(`\n${pc.bold(msg)}`);
  },
  /** Diagnostic/context output (stderr). */
  dim(msg: string): void {
    if (level !== 'quiet') console.error(pc.dim(msg));
  },
  warn(msg: string): void {
    if (level !== 'quiet') console.error(`${pc.yellow('▲')} ${msg}`);
  },
  fail(msg: string): void {
    console.error(`${pc.red('✖')} ${msg}`);
  },
  /** Only shown with --verbose (stderr). */
  debug(msg: string): void {
    if (level === 'verbose') console.error(pc.dim(`[debug] ${msg}`));
  },
  /** Machine-readable result document (stdout), for --json commands. */
  json(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
  },
};
