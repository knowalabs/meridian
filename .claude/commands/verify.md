---
description: Run DevPilot's full verify/fix loop in CI order and fix failures
---

Run this repo's exact CI order from `.github/workflows/ci.yml` and fix any failures before moving to the next step — do not skip ahead:

1. `npm run lint` (`eslint src tests`) — fix violations directly; do not disable rules like `@typescript-eslint/no-explicit-any`, `no-floating-promises`, or `no-misused-promises` to silence errors.
2. `npx prettier --check .` — if it fails, run `npm run format` and re-check.
3. `npm run build` (`tsc -p tsconfig.build.json`) — fix type errors; this project uses `strict`, `noUncheckedIndexedAccess`, and `noImplicitOverride`.
4. `npm run test:coverage` (`vitest run --coverage`) — coverage thresholds are 70% lines / 60% branches over `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts`. If a new module drags coverage down, add tests rather than lowering the threshold.
5. Only if the change touches `generate`, `cli.ts`, or anything exercised end-to-end: `npm run test:e2e` (this rebuilds via `pretest:e2e` first).

If `$ARGUMENTS` names a specific step (e.g. "lint", "build", "coverage"), run only that step and its prerequisites. Report which step failed, the root cause, and the fix applied — do not just re-run commands hoping they pass.
