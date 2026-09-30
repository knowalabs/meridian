import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../core/errors.js';
import { resolveInside, writeFileAtomic } from '../core/fsx.js';
import { isAllowedPath } from '../generate/artifacts.js';
import { claimedPaths, claimedScripts, isConcretePath } from '../generate/validate.js';

/*
 * Lessons: one-line rules that each came from a change which failed this
 * project's own checks and was then fixed. They live in their own file so
 * `meridian generate rules --force` — which rewrites rules.md — can never
 * erase them, and they are rendered into every tool's instruction file after
 * the rules.
 *
 * A lesson is text an AI wrote that ends up in every other AI's instructions,
 * which makes this file a prompt-injection path into every agent. So nothing
 * reaches it without a human approving the exact text, and every line is
 * validated again whenever it is read — an agent with write access to
 * `.meridian/` can edit the file directly.
 */

export const LESSONS_FILE = '.meridian/lessons.md';
/** Every lesson is loaded on every request by every tool; the list stays short. */
export const MAX_LESSONS = 25;
export const MAX_LESSON_CHARS = 200;
const MIN_LESSON_CHARS = 12;

const FILE_HEADER = `# Lessons learned

Each rule below came from a change that failed this project's checks and was then
fixed. They are copied into every AI tool's instruction file; manage them with
\`meridian lessons\`.
`;

export type LessonCheck = { ok: true; text: string } | { ok: false; reason: string };

/** Characters a reviewer cannot see but a model reads: zero-width, bidi overrides, BOM. */
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WEAKENS_CHECKS =
  /\b(skip|skipping|disable|disabling|bypass|ignore|silence|suppress|loosen|weaken|comment out|delete|remove)\b[^.;]{0,40}\b(tests?|checks?|lint(er|ing)?|verif(y|ication)|assert(ions?)?|coverage|hooks?|ci|type ?check(ing)?)\b/i;
const CHECK_ESCAPES =
  /--no-verify|\.skip\(|\bxit\(|@ts-ignore|@ts-nocheck|eslint-disable|noqa|# type: ignore/i;
const OVERRIDES =
  /\b(ignore|disregard|override|forget)\b[^.;]{0,30}\b(previous|prior|above|earlier|all|other|these)\b[^.;]{0,20}\b(instructions?|rules?|prompts?|guidelines?)\b|\bsystem prompt\b|\byou are now\b/i;

/** Text outside backtick code spans, where Claude expands `@path` into the file's contents. */
const outsideCode = (text: string): string => text.replace(/`[^`]*`/g, '');

/** Normalised form for spotting a lesson that repeats another in different case or spacing. */
export const lessonKey = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Whether `raw` may stand as a lesson, independent of any project: one
 * visible, plain line of reasonable length, with no markup, links, file
 * inclusions, override phrasing, or advice to weaken the checks it came from.
 */
export function checkLessonText(raw: string): LessonCheck {
  const text = raw.normalize('NFKC').trim();
  if (CONTROL.test(text))
    return { ok: false, reason: 'contains a line break or control character' };
  if (INVISIBLE.test(text)) return { ok: false, reason: 'contains invisible characters' };
  if (/^none\.?$/i.test(text)) return { ok: false, reason: 'the agent found nothing worth a rule' };
  if (text.length < MIN_LESSON_CHARS) return { ok: false, reason: 'too short to be a rule' };
  if (text.length > MAX_LESSON_CHARS) {
    return { ok: false, reason: `longer than ${MAX_LESSON_CHARS} characters` };
  }
  if (/^(#|>|-{3}|\*{3}|[-*+]\s|\d+[.)]\s|`{3}|~{3})/.test(text) || text.includes('```')) {
    return { ok: false, reason: 'contains markdown structure' };
  }
  if (text.includes('<')) return { ok: false, reason: 'contains HTML' };
  if (/\b(?:https?|ftp|file):\/\/|\bwww\./i.test(text))
    return { ok: false, reason: 'contains a link' };
  if (/(?:^|[\s(])@[^\s`]/.test(outsideCode(text))) {
    return { ok: false, reason: 'contains an @ file reference' };
  }
  if (OVERRIDES.test(text)) return { ok: false, reason: 'tries to override other instructions' };
  if (WEAKENS_CHECKS.test(text) || CHECK_ESCAPES.test(text)) {
    return { ok: false, reason: 'weakens or skips a check' };
  }
  return { ok: true, text };
}

/**
 * Whether a lesson may be proposed for this project: `checkLessonText`, plus
 * every script and path it names must exist here, and it must not repeat a
 * lesson already accepted or pending. A rule that sends every agent to a
 * script this project does not have is worse than no rule.
 */
export function validateLesson(
  root: string,
  raw: string,
  scripts: Record<string, string>,
  existing: string[],
): LessonCheck {
  const checked = checkLessonText(raw);
  if (!checked.ok) return checked;
  for (const claim of claimedScripts(checked.text)) {
    if (!(claim.script in scripts)) {
      return { ok: false, reason: `names \`${claim.command}\`, which this project does not have` };
    }
  }
  for (const file of claimedPaths(checked.text)) {
    if (!isConcretePath(file)) continue;
    if (!resolveInside(root, file) || !fs.existsSync(path.join(root, file))) {
      return { ok: false, reason: `names ${file}, which does not exist here` };
    }
  }
  const key = lessonKey(checked.text);
  if (existing.some((e) => lessonKey(e) === key)) {
    return { ok: false, reason: 'repeats an existing lesson' };
  }
  return checked;
}

export interface ReadLessons {
  lessons: string[];
  /** Lines left out of every mirror, and why. */
  dropped: { line: string; reason: string }[];
}

/**
 * The accepted lessons. Each line is validated again here, because the file
 * can be edited by anything with write access to the repository — including
 * an agent — and only lines that still pass reach the mirrors.
 */
export function readLessons(root: string): ReadLessons {
  const result: ReadLessons = { lessons: [], dropped: [] };
  const file = path.join(root, LESSONS_FILE);
  if (!fs.existsSync(file)) return result;
  if (!resolveInside(root, LESSONS_FILE)) {
    result.dropped.push({ line: LESSONS_FILE, reason: 'leads outside this project' });
    return result;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return result;
  }
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const checked = checkLessonText(bullet[1]!);
    if (!checked.ok) {
      result.dropped.push({ line: bullet[1]!, reason: checked.reason });
      continue;
    }
    const key = lessonKey(checked.text);
    if (seen.has(key)) continue;
    if (result.lessons.length >= MAX_LESSONS) {
      result.dropped.push({ line: checked.text, reason: `over the limit of ${MAX_LESSONS}` });
      continue;
    }
    seen.add(key);
    result.lessons.push(checked.text);
  }
  return result;
}

/**
 * Replace the accepted lessons. Callers validate first; this checks the
 * structural rules again anyway, since it is the last step before the text
 * reaches every tool. An empty list removes the file.
 */
export function writeLessons(root: string, lessons: string[]): void {
  if (!isAllowedPath(LESSONS_FILE, [LESSONS_FILE]) || !resolveInside(root, LESSONS_FILE)) {
    throw new CliError(`${LESSONS_FILE} leads outside this project.`, {
      hint: 'It is a symlink to a file elsewhere on this machine. Replace it with a regular file.',
    });
  }
  if (lessons.length > MAX_LESSONS) {
    throw new CliError(`A project holds at most ${MAX_LESSONS} lessons.`, {
      hint: 'Remove one with "meridian lessons remove <n>" first.',
    });
  }
  const lines = lessons.map((lesson) => {
    const checked = checkLessonText(lesson);
    if (!checked.ok) throw new CliError(`Refusing a lesson that ${checked.reason}: "${lesson}"`);
    return `- ${checked.text}`;
  });
  const file = path.join(root, LESSONS_FILE);
  if (lines.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  writeFileAtomic(file, `${FILE_HEADER}\n${lines.join('\n')}\n`);
}

/**
 * The lessons as a section appended to the rules in every mirror, or '' when
 * there are none — so a project without lessons renders exactly as before.
 */
export function lessonsSection(lessons: string[]): string {
  if (lessons.length === 0) return '';
  return `## Lessons learned

Each of these came from a change that failed this project's checks and was then
fixed. They refine the rules above and never override them.

${lessons.map((l) => `- ${l}`).join('\n')}`;
}
