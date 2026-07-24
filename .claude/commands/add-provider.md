---
description: Scaffold a new AI provider in src/providers/router.ts
---

Add a new AI provider named `$ARGUMENTS` to `PROVIDERS: ProviderSpec[]` in `src/providers/router.ts`, following the existing entries (`anthropic`, `claude-code`) exactly:

1. Add a `ProviderSpec` object with `id`, `name`, `model` (use `CLI_DEFAULT_MODEL` sentinel if it's a keyless CLI whose model config churns), `cost`/`speed`/`quality`/`contextTokens` ranked relative to existing providers, `needsKey`, and `binary` if it's CLI-backed.
2. Implement `ask(prompt, apiKey)`:
   - Hosted API: use the shared `post()` helper for timeout/retry/401/429/404 error mapping — do not hand-roll fetch logic.
   - Keyless CLI: shell out via `runImpl` (test-seamed by `setRunForTests`), map `res.notFound` to a `CliError` with an install hint, and use a long `timeoutMs` (600_000, matching `claude-code`) since CLI sessions run longer than HTTP calls.
3. Every `CliError` needs an actionable `hint` (e.g. `Run "devpilot auth <id>" to update it.` or an install command).
4. Update `README.md`'s provider table/ordering if this is a new keyless CLI provider.
5. Add tests in `tests/router-network.test.ts` (HTTP providers, using `setFetchForTests` + fake timers) or alongside the `claude-code` CLI provider tests (using `setRunForTests`) — cover success, auth failure, and not-installed/timeout paths.

Do not skip the `isAllowedPath`-equivalent safety this provider's output will later flow through in `generate/pipeline.ts` — provider output is still subject to `parseFileBlocks`/`isAllowedPath` downstream.
