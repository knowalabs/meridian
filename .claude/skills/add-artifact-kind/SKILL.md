---
name: add-artifact-kind
description: Use when adding a new generated artifact kind (like rules, agents, skills, commands, prompts, docs) to devpilot generate.
---

# Adding a new artifact kind to `devpilot generate`

`devpilot generate` produces its output through `ARTIFACT_KINDS: ArtifactKind[]` in `src/generate/artifacts.ts`, orchestrated by `runGenerate`/`generateKind` in `src/generate/pipeline.ts`. Follow this exact sequence when adding a kind (e.g. a new `.claude/` file type).

1. In `src/generate/artifacts.ts`, add a new entry to `ARTIFACT_KINDS` implementing the `ArtifactKind` interface: `id`, `name`, `description`, `allowedPaths` (path prefixes or exact files the AI may write — end directory prefixes with `/`), `prompt(digest): string`, and `fallback(analysis: ProjectAnalysis): ArtifactFile[]`. Both `prompt` and `fallback` are **required together** — there is no AI-only or static-only kind.
2. Build `prompt()` with the shared `commonPrompt(kindInstructions, digest)` helper (same file) so your kind inherits the quality bar and the `<<<FILE path>>> …
