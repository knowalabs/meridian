# Debug a `devpilot generate` Run

I ran `devpilot generate <kinds…>` (or the interactive launcher's "Generate AI kit" menu item) against a target project and something went wrong — <describe the symptom: wrong/missing files, an AI call failed, a file got skipped unexpectedly, wrong content written, etc.>.

Trace the failure along the real pipeline in `src/generate/pipeline.ts:runGenerate`, in order:

1. **`src/commands/generate.ts`** — did CLI parsing/validation reject or mistranslate the `kinds`/`--provider`/`--force`/`--dry-run`/`--no-ai` flags before reaching the pipeline?
2. **`src/scan/analyzer.ts:analyzeProject`** — is the static analysis of the target project (languages, frameworks, scripts, dependency list, directory tree) correct for this project? This step is read-only and never writes files.
3. **`src/generate/digest.ts:buildDigest`** — does the digest text (`digest.text`) actually contain the facts and source excerpts needed? Check whether a relevant file simply wasn't picked up as a "key file excerpt."
4. **`src/providers/router.ts`** — did `pickProvider`/`route()` in `src/generate/pipeline.ts` select the expected provider? Check `availableProviders()` and whether a forced `--provider` id matched an available one. If it's an HTTP provider, check the `post()` helper's status-code mapping (401 → `devpilot auth <provider>`, 429 → one retry then error, 404 → stale model, timeout → `DEFAULT_TIMEOUT_MS`/CLI-provider timeout). If it's a keyless CLI provider, check `runImpl`/`which` and whether the binary is signed in.
5. **`generateKind`** (`src/generate/pipeline.ts`) — remember this is **fail-closed**: if the AI call for a kind failed or returned no parseable file blocks after one retry, _nothing is written for that kind_ — this is intentional (a later re-run retries with AI), not a bug, unless the failure itself is unexpected.
6. **`src/generate/artifacts.ts:parseFileBlocks`** — did the AI response actually match the `<<<FILE path>>> …
