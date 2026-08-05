# Implement a New Artifact Kind or Provider in Knowa

I'm adding <describe: a new `ArtifactKind` to `knowa generate`, OR a new provider to `src/providers/router.ts`>. Follow this project's architecture exactly — do not invent new patterns where an existing one already fits.

## If this is a new artifact kind (`src/generate/artifacts.ts`)

1. Add an entry to `ARTIFACT_KINDS: ArtifactKind[]` with `id`, `name`, `description`, `allowedPaths` (path prefixes/exact files the AI may write for this kind — this is enforced by `isAllowedPath`, which blocks absolute paths, Windows drive letters and `..` traversal).
2. Implement `prompt(digest: string): string` — build the AI prompt for this kind. Follow the `commonPrompt()` helper pattern already used by other kinds (see `src/generate/artifacts.ts`) and the `<<<FILE path>>> …
