import pc from 'picocolors';
import { CliError, EXIT } from '../core/errors.js';
import { jsonMode, log } from '../core/logger.js';
import {
  acceptLesson,
  pendingLessons,
  rejectLesson,
  removeLesson,
  type LessonsApplied,
} from '../harness/lessons.js';
import { readLessons } from '../rules/lessons.js';

/** `meridian lessons`: the accepted lessons every tool reads, then the ones awaiting review. */
export function lessonsListCommand(cwd: string = process.cwd()): number {
  const { lessons, dropped } = readLessons(cwd);
  const pending = pendingLessons(cwd);
  if (jsonMode()) {
    log.json({ accepted: lessons, dropped, pending });
    return EXIT.OK;
  }
  if (!lessons.length && !pending.length && !dropped.length) {
    log.info('No lessons yet.');
    log.dim(
      'meridian agent proposes one after a change that failed your checks and was then fixed.',
    );
    return EXIT.OK;
  }
  if (lessons.length) {
    log.title(`Lessons (${lessons.length}) — in every AI tool's instructions`);
    lessons.forEach((l, i) => log.info(`  ${pc.dim(`${i + 1}.`)} ${l}`));
  }
  for (const d of dropped)
    log.warn(`Left out of every tool's instructions: "${d.line}" — it ${d.reason}.`);
  if (pending.length) {
    log.title(`Awaiting review (${pending.length})`);
    for (const p of pending) {
      log.info(`  ${pc.bold(p.id)}  ${p.text}`);
      log.info(
        pc.dim(`        from a failing ${p.command} · ${p.provider} · ${p.createdAt.slice(0, 10)}`),
      );
    }
    log.dim(
      '\n  Accept with: meridian lessons accept <id>   Turn down with: meridian lessons reject <id>',
    );
  }
  return EXIT.OK;
}

function reportApplied(verb: string, text: string, applied: LessonsApplied): void {
  if (jsonMode()) {
    log.json({ [verb]: text, ...applied });
    return;
  }
  log.ok(
    `${verb === 'accepted' ? 'Added' : 'Removed'}: ${text}\n  ${pc.dim(
      `${applied.mirrors.join(', ') || 'no mirrors'} updated · ${applied.tokenDelta >= 0 ? '+' : ''}${applied.tokenDelta} tokens per request`,
    )}`,
  );
  for (const file of applied.overwritten) log.warn(`${file} had hand edits; they were replaced.`);
}

export function lessonsAcceptCommand(id: string, cwd: string = process.cwd()): number {
  const applied = acceptLesson(cwd, id);
  reportApplied('accepted', applied.text, applied);
  return EXIT.OK;
}

export function lessonsRejectCommand(id: string, cwd: string = process.cwd()): number {
  const lesson = rejectLesson(cwd, id);
  if (jsonMode()) log.json({ rejected: lesson.text });
  else log.ok(`Turned down: ${lesson.text} ${pc.dim('(it will not be proposed again)')}`);
  return EXIT.OK;
}

export function lessonsRemoveCommand(n: string, cwd: string = process.cwd()): number {
  const index = Number(n);
  if (!Number.isInteger(index) || index < 1) {
    throw new CliError(`"${n}" is not a lesson number.`, {
      exitCode: EXIT.USAGE,
      hint: 'Use the number "meridian lessons" shows beside the lesson.',
    });
  }
  const applied = removeLesson(cwd, index);
  reportApplied('removed', applied.text, applied);
  return EXIT.OK;
}
