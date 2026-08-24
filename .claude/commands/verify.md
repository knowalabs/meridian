---
description: Run Meridian's fast verify loop (default) or the full CI-order chain with `full`
argument-hint: [fast|full|lint|format|build|test|coverage|e2e]
---

## Context

- `git status` / `git diff --stat` — what changed since the last verified state
- `package.json` scripts: `lint`, `build`, `test`, `format`, `test:coverage`, `test:e2e`, `pretest:e2e`
- `.github/workflows/ci.yml` job order: lint → `prettier --check .` → build → test:coverage → test:e2e
- `vitest.config.ts` coverage thresholds: 70% lines / 60% branches over `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts`

## Task

Pick the chain from `$ARGUMENTS`:

- A single step name (`lint`, `format`, `build`, `test`, `coverage`, `e2e`) — run only that command.
- `full` — run the full chain below.
- Anything else, or empty — run the **fast loop**. This is the default.

**Fast loop** (while iterating — stop at the first failure):

1. `npm run lint` — fix violations in the flagged files; never disable a rule to silence an error (`@typescript-eslint/no-explicit-any`, `no-floating-promises`, `no-misused-promises` are `error` on `src/**`).
2. `npm run build` (`tsc -p tsconfig.build.json`) — fix the reported type errors.
3. `npm test` (`vitest run`) — no coverage instrumentation.

**Full chain** (`full`, or when the change is finished — stop at the first failure):

1. `npx prettier --check .` — on failure run `npm run format`, then re-check.
2. `npm run lint`
3. `npm run build`
4. `npm run test:coverage` — if a new module drops coverage below the thresholds, add tests rather than lowering them.
5. Only when the change touches `src/generate/**`, `src/cli.ts`, or another end-to-end path: `npm run test:e2e`. Its `pretest:e2e` hook rebuilds first, so don't run step 3 again just for it.

## Report

Which chain ran, pass/fail per step, and for any failure: the root cause and the fix applied (not just "re-ran and it passed"). If you ran the fast loop, say so and note that the full chain is still owed before a PR.

## Constraints

Do not run the full chain when the fast loop was asked for. Do not disable a lint rule or lower a coverage threshold to make this pass. Do not commit — leave the fixes in the working tree for the user to review.
