# Reviewing a PR in Meridian

## When to use
Before merging any PR or diff touching `src/**/*.ts` or `tests/**/*.ts` in the Meridian CLI — the tool that generates AI-assistant kits for other codebases.

## Context
- Meridian (`@knowalabs/meridian`) is a single-package TypeScript CLI (Commander), no workspace — every command runs from the repo root.
- `tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch` on. New code must never need them relaxed.
- `eslint.config.js` sets `@typescript-eslint/no-explicit-any: error` (source only — `tests/**/*.ts` relaxes the unsafe-* family), `no-floating-promises: error`, `no-misused-promises: error`, and unused args must be prefixed `_`.
- `CODEOWNERS` names four security-critical paths requiring explicit sign-off: `src/core/vault.ts` (the secret vault — Keychain/libsecret/DPAPI/file backends), `src/generate/artifacts.ts` (owns `isAllowedPath`, the only guard stopping AI-suggested writes from escaping the target project), `.github/workflows/` (build/publish gating), and `SECURITY.md`.
- `src/providers/router.ts`'s `post`/`rawPost`/`classifyStatus` distinguish retryable transient failures (429/5xx, dropped connections) from timeouts, which are never retried — a diff that changes this needs to preserve that distinction.
- Module ownership: `src/generate/artifacts.ts` owns the artifact-kind contract, `src/generate/pipeline.ts` owns orchestration (`dependencyWaves`, `concurrencyFor`), `src/providers/router.ts` owns provider selection/dispatch, `src/core/vault.ts` owns secret storage, `src/rules/generators.ts` owns rendering `.meridian/rules.md` into its five mirrors, `src/mcp/configure.ts` owns MCP config writes.
- Test seam convention: module-level state needing mocking exposes `setXForTests(value | null)` (e.g. `setFetchForTests`, `setRunForTests`, `setGitForTests`, `setRetryDelayForTests`) — a diff introducing a different mocking mechanism is a defect.
- CI (`.github/workflows/ci.yml`) runs, per push/PR, across ubuntu/macos/windows × Node 18/20/22: `npm run lint`, `npx prettier --check .`, `npm run build`, `npm run test:coverage`, `npm run test:e2e`.

## Task
1. Read the full diff before forming an opinion — do not review a hunk in isolation from its file.
2. Check whether the diff touches any CODEOWNERS-flagged path (`src/core/vault.ts`, `src/generate/artifacts.ts`, `.github/workflows/`, `SECURITY.md`); if so, flag that it needs explicit sign-off and describe exactly what changed in the security-relevant behavior (e.g. does it alter `isAllowedPath`'s allowlist, or how `openVault()` selects a backend).
3. Verify every new `async` call site is awaited or otherwise handled (no floating promises) and that no `any` was introduced in `src/**/*.ts`.
4. If the diff adds or changes a test seam, confirm it follows the `setXForTests(value | null)` pattern rather than inventing a new one.
5. If the diff touches `src/generate/*` or `src/providers/router.ts`, confirm the accompanying test uses `setFetchForTests`/`setRunForTests` rather than a real network call or CLI binary.
6. Check for a `CliError` (`src/core/errors.ts`) on every new user-facing failure path rather than a bare `throw` or `console.error`.
7. Do not propose or make unrelated refactors, renames or doc edits — report them as separate observations instead.
8. State which verification commands you ran (or would need to run) from the chain in `.meridian/rules.md`, and their result.

## Output
A findings list ordered most-severe first. For each: file:line, what is wrong, why it matters (cite the rule or file it violates), and the smallest correct fix. End with a one-line verdict: approve, approve with comments, or request changes.

```
PASTE THE DIFF OR PR HERE
```
