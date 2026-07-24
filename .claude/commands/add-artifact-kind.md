---
description: Scaffold a new devpilot-generate artifact kind
---

Add a new `ArtifactKind` named `$ARGUMENTS` to `ARTIFACT_KINDS` in `src/generate/artifacts.ts`:

1. Define `id`, `name`, `description`, and `allowedPaths` (path prefixes or exact files this kind may write — validated later by `isAllowedPath`, which blocks absolute paths, drive letters, and `..` traversal).
2. Implement `prompt(digest)` using the `commonPrompt(kindInstructions, digest)` helper, describing exactly which file(s) to produce and their required structure — be as specific as the `rules` kind's prompt (multi-section outline).
3. Implement `fallback(analysis: ProjectAnalysis)` returning at least one `ArtifactFile` under `allowedPaths` with no AI provider — derive content from real analysis fields (`analysis.scripts`, `analysis.frameworks`, `analysis.tree`, etc.), never hardcoded generic text.
4. Both `prompt()` and `fallback()` are mandatory — the `static fallbacks` test in `tests/generate.test.ts` iterates `ARTIFACT_KINDS` and asserts every kind's `fallback()` output passes `isAllowedPath`. Add a case there.
5. If this kind should propagate anywhere (like `rules` mirrors into `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` via `src/rules/generators.ts`), wire that explicitly — it does not happen automatically.
6. Confirm `generateKind` in `src/generate/pipeline.ts` still fails closed for this kind (no static fallback written after a failed AI call mid-run).

Run `npm run test:coverage` after to confirm the new kind's fallback path is exercised.
