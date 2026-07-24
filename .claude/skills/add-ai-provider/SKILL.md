---
name: add-ai-provider
description: Use when adding a new AI provider (hosted API or keyless CLI) to DevPilot's router.
---

# Adding a provider to `src/providers/router.ts`

Every provider — hosted API (e.g. `anthropic`) or keyless CLI (e.g. `claude-code`) — is one entry in the `PROVIDERS: ProviderSpec[]` array in `src/providers/router.ts`, selected by `route()`/`pickProvider` (`src/generate/pipeline.ts`) on cost/speed/quality/context.

1. Add an object to `PROVIDERS` implementing `ProviderSpec`: `id`, `name`, `model` (default model string, or the `CLI_DEFAULT_MODEL` sentinel `'cli-default'` for CLI-backed providers whose model naming isn't yours to pin), `cost`/`speed`/`quality` (lower = better, ranked _relative to existing entries_ — look at `anthropic`'s `cost: 3, speed: 2, quality: 1` and `claude-code`'s `cost: 0` for calibration), `contextTokens`, `needsKey` (`false` for CLI-backed providers), and for CLI-backed providers a `binary` (the PATH executable name, e.g. `'claude'`).
2. Implement `async ask(prompt, apiKey)`. For an HTTP provider, call the shared `post(url, headers, body, { provider: this.id })` helper — it already handles timeout (`DEFAULT_TIMEOUT_MS = 60_000`), one retry on HTTP 429, and maps 401/403 → auth-failed `CliError` with hint `Run "devpilot auth ${ctx.provider}" to update it.`, 404 → model-not-found hint pointing at `router.models.<id>` config. Do not reimplement retry/timeout/error-mapping per provider.
3. For a CLI-backed provider, shell out via `runImpl`/`runAsync` (see `claude-code`'s `ask`) instead of `post()`, check `res.notFound` for a missing-binary `CliError` with a `devpilot install <tool>` hint, and give it a generous timeout (`claude-code` uses `timeoutMs: 600_000` — 10 minutes — not the 60s HTTP default) since it's a full CLI session, not a request/response call.
4. Always resolve the model through `modelFor(this)` (never read `this.model` directly) so `router.models.<id>` config overrides are honored.
5. Use `CliError` (`src/core/errors.ts`) for every failure path with an actionable `hint`, never a raw `Error` — match the pattern already in `post()`.
6. Test it in `tests/router-network.test.ts` using the existing seams: `setFetchForTests`/`setRunForTests` (never real network/subprocess calls) plus `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` for retry/timeout behavior — mirror the `anthropic`/`claude-code` describe blocks (success, 401, 429-retry-then-fail, timeout via `AbortController`, connection-failure hint).
7. Run `npm run lint && npm run build && npm run test:coverage` — `router.ts` network/retry logic is coverage-sensitive (70% lines / 60% branches over `src/**`), so untested branches in your new `ask()` can drop the whole suite below threshold.
