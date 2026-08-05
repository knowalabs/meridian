---
description: Run Knowa's format/lint/build/coverage/e2e chain in CI order and fix failures
argument-hint: [lint|format|build|coverage|e2e]
---

## Context

- `git status` / `git diff --stat` — what changed since the last verified state
- `package.json` scripts: `format`, `lint`, `build`, `test:coverage`, `test:e2e`, `pretest:e2e`
- `.github/workflows/ci.yml` job order: lint → `prettier --check .` → build → test:coverage → test:e2e
- `vitest.config.ts` coverage thresholds: 70% lines / 60% branches over `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts`

## Task

1. If `$ARGUMENTS` names one step (`lint`, `format`, `build`, `coverage`, `e2e`), run only that command; otherwise run all five below in order and stop at the first failure.
2. `npm run lint` (`eslint src tests`) — fix violations in the flagged files; never disable a rule to silence an error (`@typescript-eslint/no-explicit-any`, `no-floating-promises`, `no-misused-promises` are `error` on `src/**`).
3. `npx prettier --check .` — on failure run `npm run format`, then re-check.
4. `npm run build` (`tsc -p tsconfig.build.json`) — fix the reported type errors; the project compiles with `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
5. `npm run test:coverage` (`vitest run --coverage`) — if a new module drops coverage below the thresholds, add tests rather than lowering them.
6. Only when the change touches `src/generate/**`, `src/cli.ts`, or another end-to-end path: `npm run test:e2e` (its `pretest:e2e` hook rebuilds first).

## Report

Which step(s) ran, pass/fail for each, and for any failure: the root cause and the fix applied (not just "re-ran and it passed").

## Constraints

Do not skip a step or reorder the chain. Do not disable a lint rule or lower a coverage threshold to make this pass. Do not commit — leave the fixes staged for the user to review.
