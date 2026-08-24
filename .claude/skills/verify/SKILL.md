---
name: verify
description: Use to run Meridian's verification chain — the fast inner loop after an edit, or the full CI-order chain before a PR — and fix any failures.
---

# Verify

## When to use

Two different moments, two different chains:

- **Fast loop** — after each change while you are still working. This is the default; use it unless the change is finished.
- **Full chain** — once, when the change is done and before `@.claude/skills/commit/SKILL.md`. Mirrors `.github/workflows/ci.yml`'s `test` job order.

The full chain runs in roughly 15s, so this is about signal rather than speed: `npm test` answers "did I break something" on its own, and coverage/e2e answer questions that only matter once the change is finished.

## Before you start

- @package.json — the scripts these chains run
- @.github/workflows/ci.yml — the job order the full chain mirrors
- @vitest.config.ts — coverage thresholds (70% lines, 60% branches over `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts`)

## Fast loop

1. `npm run lint` (`eslint src tests`)
2. `npm run build` (`tsc -p tsconfig.build.json`)
3. `npm test` (`vitest run` — no coverage instrumentation)

Stop here while iterating. Skip formatting too: `npm run format` once at the end is enough, since Prettier's output doesn't depend on how many times you ran it.

## Full chain

1. `npx prettier --check .` — on failure run `npm run format`, then re-check.
2. `npm run lint` — fix violations in the flagged files; never disable a rule to silence an error.
3. `npm run build` — fix reported type errors; the project compiles with `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
4. `npm run test:coverage` (`vitest run --coverage`) — if a new module drops coverage below the thresholds, add tests rather than lowering them.
5. `npm run test:e2e` — **only** when the change touches `src/generate/**`, `src/cli.ts`, or another end-to-end path. Its `pretest:e2e` hook runs a full `tsc` itself, so when you go straight to it you can skip step 3.

When a step fails, fix the root cause in the source or test, then re-run that step and everything after it — never skip a step or add a bypass to make it pass.

## Verification

This skill _is_ the verification. The applicable chain is complete once every step exits 0. Neither chain reproduces `.github/workflows/ci.yml`'s 3×3 matrix (ubuntu/macos/windows × Node 18/20/22) — a green local run predicts, but doesn't guarantee, a green matrix run.

## Done when

- [ ] The chain you chose (fast or full) ran to completion with every step exiting 0.
- [ ] For the full chain: coverage stayed at or above 70% lines / 60% branches.
- [ ] For the full chain: `npm run test:e2e` ran if — and only if — the change touched an e2e-exercised path.

## Never

- Never run the full chain after every edit; that's what the fast loop is for.
- Never report a coverage number or an e2e result you didn't actually run — run the full chain, or say you ran the fast loop.
- Never run `npm run build` immediately before `npm run test:e2e` — `pretest:e2e` already does it.
- Never treat a coverage-threshold drop as acceptable because "the rest passes."
- Never bypass a failing check instead of fixing its root cause.
