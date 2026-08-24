---
description: Scaffold a new meridian-generate artifact kind
argument-hint: <kind-id>
---

## Context

- `src/generate/artifacts.ts` — `ARTIFACT_KINDS`, `ArtifactKind` interface, `commonPrompt`, `isAllowedPath`
- `src/generate/pipeline.ts`'s `generateKind` — the fail-closed contract every kind runs under
- `tests/generate.test.ts`'s `describe('static fallbacks')` block — the invariant every kind must satisfy

## Task

If `$ARGUMENTS` is empty, ask the user for the new kind's id and what it should produce before doing anything else.

1. Add an `ArtifactKind` entry named `$ARGUMENTS` to `ARTIFACT_KINDS` in `src/generate/artifacts.ts`, with `id`, `name`, `description`, and `allowedPaths` (exact files or path prefixes this kind may write — enforced later by `isAllowedPath`, which blocks absolute paths, drive letters and `..` traversal).
2. Implement `prompt(digest)` via `commonPrompt(kindInstructions, digest)`, naming the exact file(s) to produce and their required section structure, as specific as the `rules` kind's outline.
3. Implement `fallback(analysis: ProjectAnalysis)` returning at least one `ArtifactFile` under `allowedPaths`, derived from real `analysis` fields (`scripts`, `frameworks`, `tree`, `codeMap`, `workspaces`) — never generic boilerplate text.
4. Add a case to `tests/generate.test.ts`'s `describe('static fallbacks')` block asserting the new kind's `fallback()` output passes `isAllowedPath`.
5. If this kind should propagate elsewhere (as `rules` mirrors into `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` via `src/rules/generators.ts`), wire that explicitly — propagation never happens automatically.
6. Run `npm run test:coverage` to confirm the new kind's fallback path is exercised.

## Report

The new `ArtifactKind` id, its `allowedPaths`, the test added, and the coverage result.

## Constraints

Never bypass `isAllowedPath` for this kind's writes. Never make `generateKind` fall back to static templates after a failed AI call — a failed kind must write nothing so a re-run can retry it.
