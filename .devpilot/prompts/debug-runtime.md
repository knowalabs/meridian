# Debug a DevPilot Runtime Failure

## When to use

`devpilot` itself fails at runtime — a provider network/auth error, a vault backend failure, a `generate`/`sync` kit failure, or a launcher/TUI issue — and you need root cause before touching code.

## Context

- Every user-facing failure is a `CliError` (`src/core/errors.ts`) with an actionable `hint` — start there; the hint usually names the fix (e.g. `Run "devpilot auth ${ctx.provider}" to update it.`).
- Provider calls (`src/providers/router.ts`) retry 408/425/429/500/502/503/504 up to `MAX_ATTEMPTS = 3` with exponential backoff (`backoffFor`), honoring `Retry-After` (`retryAfterMs`); 401/403 map to an auth-failed `CliError`, 404 to a missing-model `CliError`, other 4xx are never retried. A hung request aborts via `AbortController` after `DEFAULT_TIMEOUT_MS` and is reported, not retried. `classifyStatus` is the single place that turns an HTTP status into "retry" or a specific `CliError`.
- CLI-backed providers (`claude-code`, `codex-cli`, `gemini-cli`) are spawned via `runAsync` and pipe the prompt over stdin, not argv.
- The vault (`src/core/vault.ts`) has four backends selected by `openVault()`: `KeychainVault` (macOS `security`), `SecretToolVault` (Linux `secret-tool`), `FileVault` (AES-256-GCM encrypted file, key wrapped by `DpapiProtector` on Windows via PowerShell/stdin, or left as hex via `PlainProtector`). A corrupted `FileVault` read throws a `CliError` hinting at `devpilot keys repair`, which calls `repairVault()` to back up and remove `vault.enc`/`.master`/`index.json`.
- `devpilot generate`'s pipeline (`src/generate/pipeline.ts`) is fail-closed: `generateKind` retries an incomplete/malformed AI response once, and if it's still bad, writes nothing for that kind and adds it to `GenerateResult.failed` — never silently falls back to the static template mid-run. `isQuotaError` detects usage-limit/rate-limit messages and stops the run early (`aborted`).
- `devpilot sync` compares a fresh `analyzeProject()` fingerprint against `.devpilot/manifest.json` (`src/generate/manifest.ts`'s `diffFingerprints`/`fileStates`) — drift, missing files, and hand-edited files (hash mismatch) are classified separately; hand edits are always preserved.
- The interactive launcher (`src/launcher.ts`) runs each command in-process via `buildCli({ exitOverride: true }).parseAsync`, catching `CommanderError` so one failing command can't kill the menu loop; it is excluded from coverage thresholds (human/e2e-exercised).
- Test seams exist for exactly this kind of reproduction without live network/subprocess calls: `setFetchForTests`/`setRunForTests`/`setRetryDelayForTests` in `src/providers/router.ts` (see `tests/router-network.test.ts` for the pattern with `vi.useFakeTimers()`).

## Task

1. State the exact symptom: the command run, the flags, the error message or `CliError` text (including its `hint`), and the exit code.
2. Identify which layer owns the failure — provider HTTP/CLI call, vault backend, generate pipeline, manifest/sync diff, or launcher — using the file/function references above, not a guess.
3. Trace the failure to the specific function and condition that produces it (e.g. `classifyStatus` returning a 401 CliError, `FileVault.readAll()`'s catch block, `generateKind`'s `isComplete` check failing twice).
4. State whether this is reproducible offline using the existing test seams (`setFetchForTests`, `setRunForTests`) — if so, sketch the minimal repro using that seam instead of a live call.
5. Do not propose a fix yet — first confirm root cause with a `file:line` citation for every claim. If the evidence doesn't fully explain the symptom, say what's still unknown rather than filling the gap with speculation.
6. Once root cause is confirmed, propose the smallest fix — note explicitly whether it changes the fail-closed AI-generation guarantee, the `isAllowedPath` gate, or the DPAPI legacy-fallback in `DpapiProtector.unprotect` (these must never be silently removed).

## Output

Root cause (with file:line citations), the smallest fix as a diff or precise instructions, and — if the bug is in a path already covered by `tests/router-network.test.ts`, `tests/vault*.test.ts`, `tests/sync.test.ts`, or `tests/generate.test.ts` — which existing test should have caught it, or what new test case closes the gap.

```
<paste the command run, full error output/stack trace, and any relevant environment details>
```
