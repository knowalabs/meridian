import pc from 'picocolors';
import { currentLevel, log } from '../core/logger.js';
import { CLI_DEFAULT_MODEL } from '../providers/router.js';
import type { EventSink, HarnessEvent } from './events.js';

/** Lines of a failing verify step's output shown in the terminal; the record keeps more. */
const TAIL_LINES = 15;

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Turn session events into terminal output. The agent's own words go to
 * stdout, where they can be piped; everything Meridian says about the run
 * (tools, verification, repairs, the summary) goes to stderr. Under --json
 * every event becomes one NDJSON line on stdout instead.
 */
export function createRenderer(opts: { json: boolean }): EventSink {
  if (opts.json) return (event) => log.event(event);

  const quiet = currentLevel() === 'quiet';
  const titles = new Map<string, string>();
  let midLine = false;
  let cost = 0;
  let costKnown = false;

  const say = (text: string): void => {
    if (quiet || !text) return;
    process.stdout.write(text);
    midLine = !text.endsWith('\n');
  };
  // A status line must not land at the end of a half-printed sentence.
  const note = (line: string): void => {
    if (quiet) return;
    if (midLine) {
      process.stdout.write('\n');
      midLine = false;
    }
    process.stderr.write(`${line}\n`);
  };

  return (event: HarnessEvent) => {
    switch (event.type) {
      case 'session.started': {
        const model = event.model === CLI_DEFAULT_MODEL ? 'default model' : event.model;
        const parts = [event.provider, model, `${event.mode} mode`];
        if (!event.verify) parts.push('verify off');
        if (event.resumedFrom) parts.push(`continuing ${event.resumedFrom}`);
        note(pc.dim(parts.join(' · ')));
        return;
      }
      case 'text.delta':
        say(event.text);
        return;
      case 'text':
        if (!event.streamed) say(`${event.text}\n`);
        else if (midLine) say('\n');
        return;
      case 'tool.started':
        titles.set(event.toolId, event.title);
        note(pc.dim(`  › ${event.title}`));
        return;
      case 'tool.completed':
        if (!event.ok) {
          const title = titles.get(event.toolId) ?? 'tool';
          const exit = event.exitCode !== undefined ? ` (exit ${event.exitCode})` : '';
          note(`    ${pc.red('✖')} ${title} failed${exit}`);
        }
        return;
      case 'permission.denied':
        note(`${pc.yellow('▲')} denied: ${event.tool}${event.reason ? ` — ${event.reason}` : ''}`);
        return;
      case 'verify.started':
        note(
          `${pc.bold(event.attempt > 1 ? `Verify (attempt ${event.attempt})` : 'Verify')} ${pc.dim(event.commands.join(' → '))}`,
        );
        return;
      case 'verify.step': {
        const mark = event.ok ? pc.green('✔') : pc.red('✖');
        const exit = !event.ok && event.code !== null ? ` exit ${event.code}` : '';
        note(`  ${mark} ${event.command} ${pc.dim(`${duration(event.durationMs)}${exit}`)}`);
        return;
      }
      case 'verify.result':
        if (event.failed?.tail) {
          const tail = event.failed.tail.trimEnd().split('\n').slice(-TAIL_LINES);
          note(pc.dim(tail.map((l) => `    ${l}`).join('\n')));
        }
        return;
      case 'repair.attempt':
        note(
          `${pc.yellow('↻')} Repair ${event.attempt}/${event.maxRepairs}: sending ${pc.bold(event.command)} output back to the agent`,
        );
        return;
      case 'usage':
        if (event.costUsd !== undefined) {
          cost += event.costUsd;
          costKnown = true;
        }
        return;
      case 'error':
        note(`${event.fatal ? pc.red('✖') : pc.yellow('▲')} ${event.message}`);
        if (event.hint) note(pc.dim(`  ${event.hint}`));
        return;
      case 'session.completed': {
        const files = event.filesChanged.length;
        const extra = [
          ...(costKnown ? [`$${cost.toFixed(2)}`] : []),
          `session ${event.sessionId}`,
        ].join(' · ');
        let head: string;
        switch (event.status) {
          case 'succeeded':
            head = `${pc.green('✔')} Done · ${plural(files, 'file')} changed · ${event.verify === 'passed' ? 'verified' : 'not verified'}`;
            break;
          case 'no_changes':
            head = `${pc.green('✔')} Done · no files changed`;
            break;
          case 'verify_failed':
            head = `${pc.red('✖')} Verification still failing after ${plural(event.repairs, 'repair')} · ${plural(files, 'file')} changed`;
            break;
          case 'interrupted':
            head = `${pc.yellow('▲')} Interrupted · ${plural(files, 'file')} changed`;
            break;
          case 'failed':
            head = `${pc.red('✖')} The agent run failed · ${plural(files, 'file')} changed`;
            break;
        }
        note(`\n${head} ${pc.dim(`· ${extra}`)}`);
        if (event.status === 'verify_failed' || event.status === 'interrupted') {
          note(pc.dim(`  Continue with: meridian agent --resume "<what to do next>"`));
        }
        return;
      }
      case 'turn.started':
      case 'turn.completed':
      case 'file.changed':
        return;
    }
  };
}
