# Implementing a new ArtifactKind

## When to use
Adding a new generated-file kind to `meridian generate` (a new category of AI-assistant file), or extending an existing `ArtifactKind`'s allowed paths or dependencies.

## Context
- `src/generate/artifacts.ts` owns the artifact-kind contract: the `ArtifactKind` interface (`id`, `name`, `description`, `allowedPaths`, `alwaysOverwrite`, `minFiles`, `requiredFiles`, `optIn`, `dependsOn`, `prompt()`, `fallback()`, `finalize()`), the `ARTIFACT_KINDS` array, and `isAllowedPath` — the sole guard stopping AI-suggested paths from escaping the target project (blocks absolute paths, `..` escapes, Windows drive letters). No other module writes generated kit files directly.
- `src/generate/pipeline.ts` owns orchestration: `dependencyWaves` groups kinds so everything in a wave runs concurrently once the kinds it `dependsOn` have produced their files; `generateKind` drives one kind's AI call (or static `fallback()` when no provider is configured or `--no-ai` is passed) and validates the response before writing.
- Every kind must produce a working static `fallback(analysis: ProjectAnalysis)` — `meridian generate --no-ai` and any AI failure must still leave a complete kit. `tests/generate.test.ts`'s "static fallbacks" suite asserts every kind's fallback output stays inside its own `allowedPaths` and that every kind's prompt demands `enterprise-grade` output covering `maturity gaps and trajectory` and the `Code map`.
- A kind's `prompt()` receives `upstream` files from its `dependsOn` kinds and `existing` (`ExistingKit.refresh`/`.keep`) — files already on disk under its own paths — so a refresh never guesses a new filename beside a file that already covers the same concern.
- `src/generate/validate.ts`'s `validateArtifacts` rejects a response that claims an npm script the project's `package.json` doesn't have, or references a path (`@`-reference or backticked path with a separator) that resolves nowhere in the project and isn't phrased as an adoption step — `generateKind` retries once on a blocking issue.
- `Rigor` (`light`/`standard`/`strict`, `src/generate/artifacts.ts`) controls how much process a generated working agreement imposes; a new kind that writes a working-agreement-style file should read `workingAgreementFor(rigor)` rather than hardcoding one level.
- `src/generate/manifest.ts`'s `signatureOf` (a cosmetic-insensitive hash) is how `meridian sync` tells a hand-edit from a formatter rewrite — nothing to implement here, but a new kind's output must be idempotent so re-running `generate` doesn't itself count as drift.

## Task
1. Read `src/generate/artifacts.ts` and `src/generate/pipeline.ts` in full before editing either — the artifact-kind/dependency-wave contract breaks if one moves without the other (per `.meridian/rules.md`).
2. Define the new `ArtifactKind`: its `id`, `allowedPaths` (must be under a directory already owned by this concern, or get explicit approval for a new one), and whether it `dependsOn` another kind's output.
3. Write `fallback()` first, grounded only in `ProjectAnalysis` fields the project actually has (scripts, frameworks, conventions) — never invent a script or file the analysis didn't detect.
4. Write `prompt()` to require the same bar every other kind's prompt requires: specific to the real project, no invented files/scripts/dependencies, covering the `Code map`'s load-bearing symbols, marking unmet standards as adoption steps rather than existing precedent.
5. Register the kind in `ARTIFACT_KINDS` and confirm `dependencyWaves` places it in the correct wave relative to its `dependsOn` list.
6. Add a test to `tests/generate.test.ts` following the existing `makeProject()` sandbox pattern (`fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-gen-'))`, cleaned up in `finally`), asserting the fallback stays inside `allowedPaths` via `isAllowedPath`.
7. Run `npm run lint` and `npx vitest run tests/generate.test.ts` while iterating; run the full chain in `.meridian/rules.md` before calling it done.
8. Report any bug you find outside this scope instead of fixing it silently — name the file:line and the smallest correct fix.

## Output
The new/changed code in `src/generate/artifacts.ts` (and `pipeline.ts` if the dependency graph changed), the new test in `tests/generate.test.ts`, and a short note on which wave the kind runs in and why.

```
NAME THE NEW ARTIFACT KIND, WHAT IT SHOULD GENERATE, AND WHICH EXISTING KIND(S) IT SHOULD DEPEND ON (IF ANY)
```
