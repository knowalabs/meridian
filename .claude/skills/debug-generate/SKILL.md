---
name: debug-generate
description: Use when a devpilot generate (or sync) run produced wrong, missing, or stale files and the cause needs tracing through the digest/pipeline.
---

# Debug Generate

## When to use

A `devpilot generate` (or `devpilot sync`) run wrote nothing for a kind, wrote the wrong content, rejected a path, or seems to be using stale AI review data. Not for adding new capability — that's `@.claude/skills/add-artifact-kind/SKILL.md` or `@.claude/skills/add-ai-provider/SKILL.md`.

## Before you start

- @src/generate/pipeline.ts — `runGenerate`, `generateKind` (the fail-closed retry loop), `pickProvider`
- @src/generate/digest.ts — `buildDigest`, `digestBudgetFor`, `excerpt`, `sampleSources`
- @src/generate/artifacts.ts — `parseFileBlocks`, `isAllowedPath`
- @src/generate/cache.ts — `readCachedReview`/`writeCachedReview`, keyed by project/provider/model/digest
- @CLAUDE.md — "AI generation... is fail-closed: a failed AI call must write nothing, never silently fall back to the static template mid-run"

## Steps

1. Reproduce with `devpilot generate --dry-run --json [kind]` (or the failing kind by id) in the target project — this shows the planned `FileResult[]` (`action`, `source`) without writing anything.
2. Run `devpilot generate --estimate` to see the digest size and token estimate with no AI call — rules out a digest-budget problem (`digestBudgetFor`) before suspecting the provider.
3. If the `GenerateResult.failed` array names the kind, the AI response either returned zero `<<<FILE>>>` blocks or was missing a `requiredFiles` entry after one retry — `generateKind` in `pipeline.ts` writes nothing in that case by design; check the printed warning for which.
4. If a file shows `action: 'rejected-path'`, the AI (or fallback) suggested a path outside the kind's `allowedPaths` — verify against `isAllowedPath` in `artifacts.ts` (absolute paths, `C:\` drive letters, and `..` escapes are always rejected).
5. If output looks stale, rerun with `--no-cache` to bypass `cache.ts`'s cached codebase review and force a fresh read.
6. Reproduce the failure deterministically as a test using `setFetchForTests`/`setRunForTests` (never real network), following the temp-project pattern (`makeProject()`) in `tests/generate.test.ts`.

## Verification

`npm run test -- generate` (or `vitest run tests/generate.test.ts`) to confirm the reproduction and fix, then the full chain: `npm run format`, `npm run lint`, `npm run build`, `npm run test:coverage`, `npm run test:e2e` (required — this touches `generate`).

## Done when

- [ ] Root cause is identified with a file:line reference, not a guess.
- [ ] A regression test was added under `tests/generate.test.ts` (or `tests/sync.test.ts` for sync-specific drift).
- [ ] The full verification chain is green.

## Never

- Never make the fix silently fall back to a static template mid-AI-run — that breaks the fail-closed invariant.
- Never bypass `isAllowedPath` to "just make a rejected path work."
- Never add a real network call while reproducing — use `setFetchForTests`/`setRunForTests`.
