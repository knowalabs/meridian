---
description: Run the full CI verification chain in order and fix what fails.
---

## Context

- `.github/workflows/ci.yml`'s `test` job, for the exact command order.
- `.meridian/rules.md`'s Verification section, which mirrors that order.

## Task

1. Run, in order, stopping at the first failure: `npm run lint`, `npx prettier --check .`, `npm run build`, `npm run test:coverage`, `npm run test:e2e`.
2. On a failure, read the reported `file:line` and its matching test in `tests/*.test.ts` (or `tests/e2e/*.test.ts` for the last step) before editing.
3. Fix the issue in the module that owns it; never silence the check that caught it.
4. Remember `test:e2e`'s own `pretest:e2e` hook rebuilds `dist/` — a prior `npm run build` does not make it redundant, and a stale `dist/` from a failed build is the classic way this chain lies.
5. Re-run the full chain from the top once every failure is fixed, since a later fix can break an earlier step.

## Report

- Each command run, its result, and every fix made with `file:line`.
- Stop and report immediately, without fixing, if a failure would require touching `src/core/vault.ts`, `src/generate/artifacts.ts`, `.github/workflows/`, or `SECURITY.md`.

## Constraints

- Never skip a step or lower `test:coverage`'s thresholds to reach green.
- Never commit or push as part of this command.
