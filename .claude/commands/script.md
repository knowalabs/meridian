---
description: Run one of this project's package.json scripts and fix what it reports.
argument-hint: <script-name (test, lint, format, build, test:coverage, test:e2e)>
---

## Context

- `package.json`'s `scripts` block, for the exact command `$ARGUMENTS` maps to.
- `.meridian/rules.md`'s Verification section, for where this script sits in the chain.

## Task

1. Use `$ARGUMENTS` as the script name. If empty, ask which script to run (test, lint, format, build, test:coverage, test:e2e) — do not guess.
2. Run `npm run <script>` via Bash (e.g. `npm test`, `npm run lint`) and capture the full output.
3. For each failure, open the exact `file:line` it reports and read the surrounding code and its matching test in `tests/*.test.ts` before editing.
4. Fix the issue in the module that owns it, matching that file's existing error-handling, typing and test-seam conventions. Do not fix unrelated findings — report them instead per `.meridian/rules.md`'s bug-reporting rule.
5. Re-run the same script to confirm it now passes.

## Report

- The script run, pass/fail before and after, and each `file:line` fixed with a one-line reason.
- Any unrelated defect noticed but left unfixed.

## Constraints

- Never relax a lint rule, a `tsconfig.json` strict flag, or `test:coverage`'s 70%/60% thresholds to make the script pass.
- Stop and report before touching `src/core/vault.ts`, `src/generate/artifacts.ts`, `.github/workflows/`, or `SECURITY.md` — those need sign-off first.
