---
name: refactor
description: Use when improving the structure, naming, or consistency of existing code in this project without changing its behavior — the pin-then-transform-then-verify workflow for this codebase's aging or inconsistent areas.
---

# Refactor

## When to use

Use when the goal is to make existing code match this project's own standard — renaming, extracting, deduplicating, deleting dead code — with no change to what it does. Not for fixing a defect (report it per step 5 below and get approval first) and not for adding behavior (that's a feature — plan it with `superpowers:brainstorming` first).

## Before you start

- @.meridian/rules.md — sections 1–2 (read before write, follow the architecture) and the Legacy code section.
- @docs/conventions.md — the full naming/style catalogue to refactor _toward_.
- The file(s) you are about to change, in full, plus their existing test file under `tests/`.
- If the target has no test file, note that now — step 1 covers it.

## Steps

1. Pin current behavior before touching anything. Run the existing test for the file (`npx vitest run tests/<name>.test.ts`); if none exists, write characterization tests first that capture what the code does today (see `tests/generate.test.ts`'s and `tests/sync.test.ts`'s `makeProject`/`fs.mkdtempSync` fixture style for this repo's test-setup convention) — they must pass before and after.
2. Apply exactly one transformation at a time, in this order: rename → extract → inline → deduplicate → delete dead code. Run `npm run lint` and the target test file between each step, not just at the end.
3. Make the code consistent with this project's _standard_, not with whatever pattern sits next to it. Where the surrounding code falls short — e.g. a bare `throw` where `CliError` is called for, a bespoke mock instead of the `setXForTests(value | null)` seam convention (`setFetchForTests`, `setRunForTests`, `setGitForTests`, `setToolDetectionForTests`, `setRetryDelayForTests`) — refactor to the standard and name the local habit you deliberately did not copy in your summary.
4. Justify any optimization with a measurement or a complexity argument, not a hunch — e.g. `concurrencyFor`/`inPool` in `src/generate/pipeline.ts` cap parallelism from a provider's real limit, not a guessed number; match that evidence bar for anything you speed up.
5. If you find a defect the task didn't ask you to fix, stop and report it: `file:line`, what breaks, the smallest correct fix. Do not fix it inside the refactor. Fix it only after approval, as its own change with a regression test that fails before and passes after.
6. Run the full verification chain once the transformations are done (see below), not just the file-scoped one from step 2.

## Verification

- Per step: `npm run lint` and `npx vitest run <changed test file>`.
- Full chain before calling the refactor done, in CI's order: `npm run lint` → `npx prettier --check .` → `npm run build` → `npm run test:coverage` → `npm run test:e2e`.
- If any step fails, stop and fix before the next transformation — do not stack an untested change on top of a broken one.

## Done when

- [ ] Every characterization/existing test still passes, unchanged in assertions.
- [ ] The public interface (exported functions, CLI flags, `CliError` shapes) is identical to before.
- [ ] No output, exit code, or side effect differs from before the refactor.
- [ ] Any defect found along the way was reported and left for a separate, approved fix.
- [ ] No two live code paths do the same job — the old one was deleted, not left beside the new one.

## Never

- Never change a public interface, output, or side effect and call it a refactor — that is a behavior change, gated by its own approval and test.
- Never rewrite a test's assertions to match new internals instead of keeping it as the behavior pin.
- Never invent a new mocking mechanism when a `setXForTests(value | null)` seam already exists for that module.
- Never leave a superseded code path in place "just in case" — delete it once its replacement is verified.
