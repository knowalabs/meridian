import crypto from 'node:crypto';
import type { ProviderSpec } from '../providers/router.js';
import { changedSince, worktreeSnapshot } from '../scan/git.js';
import {
  HARNESS_PROTOCOL_VERSION,
  createEmitter,
  type EventSink,
  type HarnessEventBody,
  type HarnessMode,
  type LessonSkipReason,
  type SessionStatus,
  type TurnReason,
} from './events.js';
import { runDriverTurn, type TurnOutcome } from './drivers/index.js';
import type { Driver } from './drivers/types.js';
import { policyFor, type DriverPolicy } from './policy.js';
import type { ResumeInfo } from './session.js';
import { repairPrompt, runVerify, type VerifyFailure } from './verify.js';
import { readLessons } from '../rules/lessons.js';
import {
  hasKit,
  lessonPrompt,
  parseLesson,
  pendingLessons,
  proposeLesson,
  type PendingLesson,
} from './lessons.js';

export interface AgentSessionOptions {
  sessionId: string;
  root: string;
  task: string;
  spec: ProviderSpec;
  driver: Driver;
  model: string;
  mode: HarnessMode;
  /** Commands that decide whether the change is done; empty skips verification. */
  verifyCommands: string[];
  verify: boolean;
  maxRepairs: number;
  cliVersion: string | null;
  sinks: EventSink[];
  /** A recorded session to continue instead of starting a new one. */
  resume?: ResumeInfo;
  signal?: AbortSignal;
  /**
   * After a repaired success, ask the agent for the rule that would have
   * prevented the failure. Off unless asked for: it costs an extra turn.
   */
  learn?: boolean;
}

export interface AgentSessionResult {
  sessionId: string;
  status: SessionStatus;
  filesChanged: string[];
  /** A lesson the session proposed, pending a human's approval. */
  lesson?: PendingLesson;
}

/** A lesson turn is a question, not a task: it gets minutes, not the quarter hour a task may take. */
const LESSON_IDLE_MS = 3 * 60_000;

/**
 * What the agent is told beyond the user's words: that it will be judged by
 * commands it can run itself, or that it may only look. The task itself is
 * passed through untouched.
 */
export function taskPrompt(task: string, mode: HarnessMode, verifyCommands: string[]): string {
  if (mode === 'plan') {
    return `${task}\n\nThis is a read-only session: investigate and propose, but do not modify files.`;
  }
  if (verifyCommands.length === 0) return task;
  return `${task}\n\nWhen you finish, your change is verified by running, in order: ${verifyCommands
    .map((c) => `\`${c}\``)
    .join(', ')}. Make sure they pass.`;
}

/**
 * One agent session: a turn, then verification by the project's own chain,
 * then repair turns on the same agent session until it passes or the repair
 * budget runs out. Which files changed is decided by the working tree, not by
 * what the agent says it did — an agent that edits through a shell command
 * or commits its work is still seen.
 */
export async function runAgentSession(opts: AgentSessionOptions): Promise<AgentSessionResult> {
  const { root, spec, driver, mode, verifyCommands, signal } = opts;
  const emitter = createEmitter(opts.sessionId, opts.sinks);
  const started = Date.now();
  const reported = new Set<string>();
  // The agent's last complete message in the current turn: a lesson turn's answer.
  let lastText: string | null = null;
  const emit = (body: HarnessEventBody): void => {
    if (body.type === 'file.changed') reported.add(body.path);
    if (body.type === 'text') lastText = body.text;
    emitter.emit(body);
  };

  emit({
    type: 'session.started',
    protocol: HARNESS_PROTOCOL_VERSION,
    cwd: root,
    task: opts.task,
    provider: spec.id,
    model: opts.model,
    mode,
    verify: opts.verify,
    maxRepairs: opts.maxRepairs,
    ...(opts.resume ? { resumedFrom: opts.resume.sessionId } : {}),
  });

  const policy = policyFor(root, mode, verifyCommands);
  const before = worktreeSnapshot(root);
  let turn = opts.resume?.turns ?? 0;
  let driverSessionId = opts.resume?.driverSessionId ?? null;
  let costSoFar = opts.resume?.costUsd ?? 0;
  const newSessionId = crypto.randomUUID();

  const warning = driver.warning?.({
    cwd: root,
    prompt: opts.task,
    model: opts.model,
    policy,
    cliVersion: opts.cliVersion,
    priorCostUsd: costSoFar,
    turn: turn + 1,
  });
  if (warning) emit({ type: 'error', message: warning, fatal: false, source: 'harness' });

  const runTurn = async (
    prompt: string,
    reason: TurnReason,
    turnPolicy: DriverPolicy = policy,
    idleTimeoutMs?: number,
  ): Promise<TurnOutcome> => {
    turn++;
    lastText = null;
    emit({ type: 'turn.started', turn, reason });
    const outcome = await runDriverTurn(
      spec,
      driver,
      {
        cwd: root,
        prompt,
        model: opts.model,
        policy: turnPolicy,
        ...(driverSessionId ? { resume: driverSessionId } : { newSessionId }),
        cliVersion: opts.cliVersion,
        priorCostUsd: costSoFar,
        turn,
      },
      emit,
      signal,
      idleTimeoutMs,
    );
    if (outcome.driverSessionId) driverSessionId = outcome.driverSessionId;
    if (outcome.cumulativeCostUsd !== undefined) costSoFar = outcome.cumulativeCostUsd;
    emit({
      type: 'turn.completed',
      turn,
      ok: outcome.ok,
      driverSessionId,
      ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
    });
    if (!outcome.ok && !outcome.aborted && outcome.error) {
      emit({
        type: 'error',
        message: `${spec.id}: ${outcome.error}`,
        // A lesson turn failing costs a lesson, not the verified change before it.
        fatal: reason !== 'lesson',
        source: 'driver',
      });
    }
    return outcome;
  };

  // Outside git there is no snapshot to compare, so the agent's own report stands in.
  const changes = (): string[] => {
    const after = before ? worktreeSnapshot(root) : null;
    return before && after ? changedSince(root, before, after) : [...reported].sort();
  };

  let lesson: PendingLesson | undefined;
  const finish = (
    status: SessionStatus,
    verify: 'passed' | 'failed' | 'skipped',
    repairs: number,
  ): AgentSessionResult => {
    const filesChanged = changes();
    emit({
      type: 'session.completed',
      status,
      turns: turn,
      repairs,
      filesChanged,
      verify,
      durationMs: Date.now() - started,
    });
    return { sessionId: opts.sessionId, status, filesChanged, ...(lesson ? { lesson } : {}) };
  };

  /**
   * One read-only turn asking the agent that just repaired `failed` for the
   * rule that would have prevented it. Returns false only when the turn
   * changed files after all, and re-verifying them failed — the one case
   * where learning costs the session its verified result.
   */
  const learn = async (failed: VerifyFailure, attempt: number): Promise<boolean> => {
    const skip = (reason: LessonSkipReason, detail?: string): true => {
      emit({ type: 'lesson.skipped', reason, ...(detail ? { detail } : {}) });
      return true;
    };
    if (!driverSessionId) return skip('no-session');
    if (!hasKit(root)) return skip('no-kit');
    const existing = [...readLessons(root).lessons, ...pendingLessons(root).map((p) => p.text)];
    const beforeLesson = worktreeSnapshot(root);
    const outcome = await runTurn(
      lessonPrompt(failed, existing),
      'lesson',
      policyFor(root, 'plan', []),
      LESSON_IDLE_MS,
    );
    const afterLesson = beforeLesson ? worktreeSnapshot(root) : null;
    if (beforeLesson && afterLesson && changedSince(root, beforeLesson, afterLesson).length) {
      skip('modified-files');
      emit({
        type: 'error',
        message: 'The agent changed files while it was only asked for a lesson; verifying again.',
        fatal: false,
        source: 'harness',
      });
      const recheck = await runVerify(root, verifyCommands, emit, attempt + 1, signal);
      return recheck.passed;
    }
    if (outcome.aborted || signal?.aborted) return skip('interrupted');
    if (!outcome.ok) return skip('turn-failed');
    const parsed = parseLesson(lastText);
    if (parsed.kind === 'none') return skip('none');
    if (parsed.kind === 'unparseable') return skip('unparseable');
    const proposed = proposeLesson(root, parsed.text, {
      command: failed.command,
      provider: spec.id,
      sessionId: opts.sessionId,
    });
    if (!proposed.ok) return skip(proposed.reason, proposed.detail);
    lesson = proposed.lesson;
    emit({
      type: 'lesson.proposed',
      lessonId: lesson.id,
      text: lesson.text,
      command: failed.command,
    });
    return true;
  };

  const first = await runTurn(
    opts.resume ? opts.task : taskPrompt(opts.task, mode, verifyCommands),
    opts.resume ? 'followup' : 'task',
  );
  if (first.aborted || signal?.aborted) return finish('interrupted', 'skipped', 0);
  if (!first.ok) return finish('failed', 'skipped', 0);
  // "Nothing changed" needs proof. Outside git an edit made through a shell
  // command is invisible, so an empty report is not evidence and verify runs.
  if (before && changes().length === 0) return finish('no_changes', 'skipped', 0);
  if (!opts.verify || mode === 'plan') return finish('succeeded', 'skipped', 0);
  if (verifyCommands.length === 0) {
    emit({
      type: 'error',
      message:
        'Nothing to verify with: this project has no lint, typecheck, build or test command.',
      fatal: false,
      source: 'verify',
      hint: 'Add a test script, or list commands under harness.verify in the Meridian config.',
    });
    return finish('succeeded', 'skipped', 0);
  }

  let lastFailure: VerifyFailure | undefined;
  for (let repairs = 0; ; repairs++) {
    const result = await runVerify(root, verifyCommands, emit, repairs + 1, signal);
    if (result.aborted) return finish('interrupted', 'skipped', repairs);
    if (result.passed) {
      // Only a failure that was then fixed is proof enough to learn from.
      if (opts.learn && lastFailure && !(await learn(lastFailure, repairs + 1))) {
        return finish('verify_failed', 'failed', repairs);
      }
      return finish('succeeded', 'passed', repairs);
    }
    lastFailure = result.failed;
    if (repairs >= opts.maxRepairs) return finish('verify_failed', 'failed', repairs);
    if (!driverSessionId) {
      emit({
        type: 'error',
        message: `${spec.id} reported no session to resume, so the failure cannot be sent back to it.`,
        fatal: false,
        source: 'harness',
      });
      return finish('verify_failed', 'failed', repairs);
    }
    emit({
      type: 'repair.attempt',
      attempt: repairs + 1,
      maxRepairs: opts.maxRepairs,
      command: result.failed!.command,
    });
    const repair = await runTurn(repairPrompt(result.failed!), 'repair');
    if (repair.aborted || signal?.aborted) return finish('interrupted', 'failed', repairs + 1);
    if (!repair.ok) return finish('failed', 'failed', repairs + 1);
  }
}
