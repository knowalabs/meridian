---
description: Scaffold a new AI provider in src/providers/router.ts
argument-hint: <provider-id>
---

## Context

- `src/providers/router.ts` — `PROVIDERS: ProviderSpec[]`, `ProviderSpec` interface, shared `post()`/`postStream()` helper, `CLI_DEFAULT_MODEL` sentinel
- `tests/router-network.test.ts` — `setFetchForTests`/`setRunForTests` + `vi.useFakeTimers()` test pattern
- Existing entries (`anthropic` for a hosted API, `claude-code`/`codex-cli`/`gemini-cli` for keyless CLIs) as the templates to follow

## Task

If `$ARGUMENTS` is empty, ask the user for the new provider's id, whether it's a hosted API or a keyless CLI, and its cost/speed/quality ranking relative to existing providers before proceeding.

1. Add a `ProviderSpec` object named `$ARGUMENTS` to `PROVIDERS`: `id`, `name`, `model` (or `CLI_DEFAULT_MODEL` for a keyless CLI whose model config churns), `cost`/`speed`/`quality`/`contextTokens` ranked relative to existing entries, `needsKey`, and `binary` if CLI-backed.
2. Implement `ask(prompt, apiKey)`:
   - Hosted API: call the shared `post()` helper for timeout/retry/401/429/404 mapping — do not hand-roll `fetch`.
   - Keyless CLI: shell out via the module's runner (test-seamed by `setRunForTests`), map a not-found spawn to a `CliError` with an install hint.
3. Every `CliError` this provider throws needs an actionable `hint` (e.g. `Run "devpilot auth <id>" to update it.`).
4. Add tests in `tests/router-network.test.ts` (hosted API, via `setFetchForTests` + fake timers) or alongside the CLI provider tests (via `setRunForTests`), covering success, auth failure, and the not-installed/timeout path.
5. Update `README.md`'s provider list if this is a new keyless CLI provider.

## Report

The new provider id, whether it needs a key or a CLI binary, and the tests added.

## Constraints

Never pass a secret via a CLI's argv when stdin is available. Provider output still flows through `parseFileBlocks`/`isAllowedPath` in `src/generate/pipeline.ts` — do not add a second, separate path-writing route for this provider.
