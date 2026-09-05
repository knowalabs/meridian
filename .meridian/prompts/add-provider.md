# Adding a new AI provider to the router

## When to use
Registering a new hosted-API or CLI-backed AI provider in `src/providers/router.ts` so `meridian generate`, `meridian sync` and `meridian ask` can route to it.

## Context
- `src/providers/router.ts` owns provider selection, retry/backoff and HTTP-vs-CLI dispatch — commands call `route()`/`pickProvider()`, never a provider's API directly.
- Every provider is a `ProviderSpec`: `id`, `name`, `model` (default), optional `models` (the picker's shipped catalogue, best first — omit for a provider whose catalogue can't be usefully enumerated or is discovered per-machine, like `ollama`'s `installedOllamaModels()`), `cost`/`speed`/`quality` rankings (lower = better in class), `contextTokens`, `needsKey`, `binary` (required when `needsKey` is false — the CLI that must be on PATH), optional `parallel` (requests it can serve at once, read by `concurrencyFor` in `src/generate/pipeline.ts`), `ask(prompt, apiKey)`, and optional `askStream`.
- The keyless CLI providers (`claude-code`, `codex-cli`, `gemini-cli`) only understand a plain `ask(prompt: string)` text interface — a structured protocol added for one provider must stay optional for the rest, per `.meridian/rules.md`'s Architecture section.
- `tests/router.test.ts`'s "registry lists every supported provider" test asserts the exact sorted list of provider ids — adding a provider means updating that assertion, not just adding the spec.
- HTTP providers go through `post`/`rawPost`, which retry `RETRYABLE_STATUS` (408/425/429/500/502/503/504) up to `MAX_ATTEMPTS=3` with backoff via `classifyStatus`, honor `Retry-After`, and map a timeout straight to a non-retried `CliError`. A new HTTP provider gets this for free by calling `post`; do not reimplement retry logic per-provider.
- `MODEL_PRICING` (`src/providers/router.ts`) is a small, explicitly incomplete table keyed by model id, used by `meridian generate --estimate`; a model with no entry there and no user override under `router.pricing.<model>` in `~/.meridian/config.json` reports "unknown cost" rather than a wrong number — adding a provider does not require adding pricing, but add it if you know the provider's real per-million-token rates.
- `verifyApiKey` (`src/providers/router.ts`) is what `meridian auth` and `meridian doctor --online` use to check a stored key against the provider for free (no tokens spent) — a new keyed provider needs this path to work too.
- Test seams: `setFetchForTests` (HTTP providers, see `tests/router-network.test.ts`) and `setRunForTests` (CLI-backed providers, see the "claude-code CLI provider" and "codex-cli and gemini-cli providers" suites in the same file) — both restore the real implementation on `null`.

## Task
1. Read `post`/`rawPost`/`classifyStatus` in `src/providers/router.ts` end to end before adding an HTTP provider — the timeout-vs-retry distinction is load-bearing (per `.meridian/rules.md`).
2. Add the new `ProviderSpec` to `PROVIDERS`, filling every field the router and pipeline read (`tests/router.test.ts`'s "gives every provider the fields..." test enumerates them) — a keyless provider must set `binary`.
3. Implement `ask` (and `askStream` only if the provider's HTTP API actually supports streaming) using the shared `post`/`rawPost` helpers for an HTTP provider, or the CLI runner (`src/core/exec.ts`) piping the prompt via stdin for a CLI provider — never argv, so a huge digest never hits an OS argument-length limit.
4. Update the sorted-id assertion in `tests/router.test.ts`'s registry test to include the new provider.
5. Add a `tests/router-network.test.ts` (HTTP) or matching CLI-provider suite covering: success, auth failure (401/403 → `CliError` hinting `meridian auth <id>`), and — for HTTP — at least one retryable-status case using `setFetchForTests`/`setRetryDelayForTests`.
6. If you know the provider's real pricing, add an entry to `MODEL_PRICING`; otherwise leave it omitted rather than guessing a number.
7. Run `npx vitest run tests/router.test.ts tests/router-network.test.ts` while iterating, then the full chain in `.meridian/rules.md` before calling it done.

## Output
The new `ProviderSpec` addition to `PROVIDERS`, the updated registry-list test, the new provider test suite, and a one-line note on which model-pricing/model-catalogue decisions you made and why.

```
NAME THE PROVIDER, WHETHER IT IS HTTP-KEYED OR A KEYLESS CLI, AND ITS API/CLI DETAILS (ENDPOINT OR BINARY NAME, AUTH HEADER OR LOGIN COMMAND, MODEL NAMES)
```
