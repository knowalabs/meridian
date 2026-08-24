---
name: add-artifact-kind
description: Use when adding a new generated artifact kind (like rules, agents, skills, commands, prompts, docs, harness) to meridian generate's ARTIFACT_KINDS.
---

# Add Artifact Kind

## When to use

Adding a brand-new kind of file `meridian generate` produces (today: `rules`, `agents`, `skills`, `commands`, `prompts`, `docs`, `harness`, and the opt-in `ci`). Not for changing what an _existing_ kind writes — that's a direct edit to its `prompt`/`fallback` — and not for provider wiring, which is `@.claude/skills/add-ai-provider/SKILL.md`.

## Before you start

- @src/generate/artifacts.ts — `ArtifactKind` interface, `ARTIFACT_KINDS`, `commonPrompt`, `isAllowedPath`, `parseFileBlocks`, `kindsById`
- @src/generate/pipeline.ts — `generateKind` (the fail-closed retry/parse loop every kind goes through)
- @tests/generate.test.ts — the `describe('static fallbacks')` block, which asserts every kind's fallback output
- @CLAUDE.md — "When adding a new artifact kind... you must supply both a `prompt(digest)` and a `fallback(analysis)`"

## Steps

1. Add a new entry to `ARTIFACT_KINDS` in `src/generate/artifacts.ts`: `id`, `name`, `description`, `allowedPaths` (a prefix or exact-file allowlist), plus `minFiles`/`requiredFiles`/`alwaysOverwrite`/`optIn` as needed (see the opt-in `ci` kind for the `optIn: true` pattern that keeps a kind out of "generate everything").
2. Write `prompt(digest)` by calling `commonPrompt(kindInstructions, digest)` (as the `rules` kind does) so the shared quality bar, safety rules, and `FORMAT_SPEC` file-block protocol apply automatically — do not hand-roll a prompt from scratch.
3. Write `fallback(analysis: ProjectAnalysis)` returning `ArtifactFile[]` whose every `file` passes `isAllowedPath(file, kind.allowedPaths)` — this is enforced by the static-fallbacks test, not just convention.
4. If the kind should not ship by default (like `ci`), set `optIn: true`.
5. Update the `Kinds:` and `Opt-in kinds:` help text in the `generate` command's `addHelpText('after', …)` block in `src/cli.ts` so `meridian generate --help` stays accurate.
6. Extend `tests/generate.test.ts` with kind-specific assertions (prompt contains the right section headings; fallback content covers the cases you care about) — the generic `static fallbacks` loop already covers every kind automatically, so add cases beyond that baseline.

## Verification

Run in this order (matches `.github/workflows/ci.yml`):

1. `npm run format`
2. `npm run lint`
3. `npm run build`
4. `npm run test:coverage` — watch `tests/generate.test.ts` specifically
5. `npm run test:e2e` — required, since this touches `generate`

## Done when

- [ ] The new kind has both `prompt` and `fallback`.
- [ ] Every fallback file passes `isAllowedPath` against the kind's own `allowedPaths`.
- [ ] `meridian generate --help`'s kind list is updated.
- [ ] The full verification chain above is green.

## Never

- Never skip `fallback` — AI generation is opt-out (`--no-ai`), so every kind must work offline.
- Never construct a written path without routing it through `isAllowedPath`.
- Never write a `prompt` outside `commonPrompt` that omits the shared safety/quality instructions.
