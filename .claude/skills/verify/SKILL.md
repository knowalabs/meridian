---
name: verify
description: Use to run DevPilot's full verification chain in CI order and fix any failures before a change is considered done.
---

# Verify

## When to use

Before any change in this repo is considered finished — the mandatory, exact-order check that mirrors `.github/workflows/ci.yml`'s `test` job. Use this after implementation work, before `@.claude/skills/commit/SKILL.md`.

## Before you start

- @package.json — the scripts this chain runs
- @.github/workflows/ci.yml — the job whose order this mirrors (`lint` → `prettier --check .` → `build` → `test:coverage` → `test:e2e`)
- @vitest.config.ts — coverage thresholds (70% lines, 60% branches, over `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts`)
- @CLAUDE.md — "Verification — exact ordered commands before work is done"

## Steps

Run these commands, in this exact order — do not reorder or skip a step to save time:

1. `npm run format` (or `npx prettier --check .` to check without writing, matching how CI runs it).
2. `npm run lint` (`eslint src tests`).
3. `npm run build` (`tsc -p tsconfig.build.json`).
4. `npm run test:coverage` (`vitest run --coverage`) — confirm no new module drags lines below 70% or branches below 60%.
5. `npm run test:e2e` — only when the change touches `src/generate/*.ts`, `src/cli.ts`, or anything else exercised end-to-end; this runs `pretest:e2e` (`npm run build`) first automatically, so run it directly rather than rebuilding by hand.

When a step fails, fix the root cause in the source or test, then re-run that step (and everything after it) — never skip a step or add `--no-verify`-style bypasses to make it pass.

## Verification

This skill _is_ the verification. The chain above is complete once every applicable step exits 0. This can't reproduce `.github/workflows/ci.yml`'s full 3×3 OS/Node matrix (ubuntu/macos/windows × Node 18/20/22) locally — note that a green local run predicts, but doesn't guarantee, a green matrix run.

## Done when

- [ ] `npm run format` reports no changes needed.
- [ ] `npm run lint` passes with zero errors.
- [ ] `npm run build` completes with no type errors.
- [ ] `npm run test:coverage` passes and stays at or above the 70%/60% thresholds.
- [ ] `npm run test:e2e` ran (and passed) if the change touched `generate`, `cli.ts`, or another e2e-exercised path.

## Never

- Never skip `lint` or `format` to save time — both are separate CI steps, not optional.
- Never treat a coverage-threshold drop as acceptable because "the rest passes."
- Never reorder the chain from `lint` → `format` → `build` → `test:coverage` → `test:e2e`.
- Never bypass a failing check instead of fixing its root cause.
