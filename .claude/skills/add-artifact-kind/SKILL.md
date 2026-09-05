---
name: add-artifact-kind
description: Use when adding a new kind of file `meridian generate` can produce (alongside rules, agents, skills, commands, prompts, docs) — wiring it into the ArtifactKind contract and dependency waves.
---

# Add an artifact kind

## When to use

Use when `meridian generate` needs to produce a new category of file beyond the existing rules/agents/skills/commands/prompts/docs/harness kinds. Not for changing what one existing kind writes — edit that kind's `prompt`/`fallback` in place instead of adding a new one.

## Before you start

- @.meridian/rules.md — "Before touching `src/generate/*`, read `docs/architecture.md` plus `src/generate/artifacts.ts` and `src/generate/pipeline.ts` in full — the artifact-kind/dependency-wave contract breaks if either file moves without the other."
- `src/generate/artifacts.ts` — the `ArtifactKind` interface, `ARTIFACT_KINDS`, and one existing kind with a similar shape (e.g. `skills`, and how `commands` depends on it via `skillIndex`/`delegatingCommand`).
- `src/generate/pipeline.ts` — `dependencyWaves`, `concurrencyFor`, `generateKind`.
- `tests/generate.test.ts` — the static-fallback and prompt-shape assertions every kind must satisfy.

## Steps

1. Read the `ArtifactKind` interface and the closest existing kind end to end, including how it declares `allowedPaths`, `dependsOn`, `prompt()`, and `fallback()`.
2. Add the new entry to `ARTIFACT_KINDS`: `id`, `name`, `description`, `allowedPaths` (the path prefix(es) `isAllowedPath` will permit this kind to write — nothing outside them, ever), a `prompt(digest, upstream?, existing?)` that (per `generate.test.ts`'s own assertion) mentions "enterprise-grade", "maturity gaps and trajectory", and "Code map" the same way every other kind's prompt does, and a `fallback(analysis)` that returns at least one file, all of them inside `allowedPaths` — asserted directly in `generate.test.ts`'s "every kind produces at least one file inside its allowed paths".
3. If the new kind needs another kind's output, declare it in `dependsOn` rather than reading that kind's generated files off disk yourself — the pipeline's `dependencyWaves`/`upstreamFor` in `pipeline.ts` resolves it, generating dependencies first and handing you their files (or what's already on disk if that kind wasn't part of this run).
4. Let `validateArtifacts` (`src/generate/validate.ts`) do content validation (frontmatter, claimed scripts, claimed paths) — don't write a parallel checker. Add `minFiles`/`requiredFiles` only if the kind has a hard structural requirement.
5. Add a case to `tests/generate.test.ts` for the new kind's `fallback` (files land inside `allowedPaths`) and `prompt` (contains the required phrases), and update `tests/commands.test.ts`'s/`tests/e2e/workflows.test.ts`'s generated-file existence lists if the new kind should always produce output.
6. If this changes which module owns which concern, update `docs/architecture.md`'s ownership line for it — nowhere else.

## Verification

- `npm run lint`
- `npx vitest run tests/generate.test.ts`
- `npx vitest run tests/commands.test.ts` (and `npm run test:e2e` if you touched the generated-file list there)
- Full chain before calling it done.

## Done when

- [ ] `ARTIFACT_KINDS` has the new kind, matching `ArtifactKind` in full.
- [ ] `isAllowedPath` confines every file the kind's `fallback` and prompt-driven output can produce.
- [ ] A dependency on another kind's output goes through `dependsOn`, not a direct file read.
- [ ] `docs/architecture.md` reflects the new kind's ownership, if it changed.

## Never

- Never let a kind write outside its own `allowedPaths` — `isAllowedPath` is the only thing stopping AI-suggested output from escaping the target project, and CODEOWNERS names this file security-critical.
- Never read another kind's generated files straight off disk when a `dependsOn` declaration would do it correctly.
- Never skip the enterprise-grade/maturity-gaps/Code-map language the rest of the kit's prompts share — it's asserted directly in `generate.test.ts`.
- Never write a second content-validation path instead of extending `validateArtifacts`.
