# Add a New AI Provider to the Router

## When to use

Wiring a new hosted-API or keyless-CLI AI provider into `devpilot generate`/`devpilot ask`'s router.

## Context

- The router lives entirely in `src/providers/router.ts`. `PROVIDERS: ProviderSpec[]` is the array every new provider joins; `ProviderSpec` is `{ id, name, model, cost, speed, quality, contextTokens, needsKey, binary?, parallel?, ask(prompt, apiKey), askStream?(prompt, apiKey, onDelta) }`.
- `cost`/`speed`/`quality` are relative rankings against the existing entries (lower is better/cheaper/faster/smarter) — not absolute numbers; `contextTokens` is the model's real context window.
- Hosted-API providers use the shared `post()` helper, which already implements timeout (`DEFAULT_TIMEOUT_MS`), retry with exponential backoff on `RETRYABLE_STATUS` (408/425/429/500/502/503/504) up to `MAX_ATTEMPTS = 3`, `Retry-After` honoring (`retryAfterMs`), and `classifyStatus`'s mapping of 401/403 → auth-failed `CliError`, 404 → missing-model `CliError`. Do not hand-roll retry/timeout logic for a new provider — call `post()`/`postStream()`.
- Several providers already share the OpenAI-compatible chat-completions shape (Groq, DeepSeek, Mistral, xAI, OpenRouter) via `openAiCompatible` — a new OpenAI-compatible provider should reuse that helper rather than duplicating the request/response shape.
- Keyless CLI-backed providers (`claude-code`, `codex-cli`, `gemini-cli`) spawn a binary via `runAsync` (`src/core/exec.ts`) and pipe the prompt over **stdin**, never as a CLI argument — see `claudeCode.ask` piping `-p` and reading stdout, and `codex.ask` preferring a `-o` output file over noisy stdout.
- Every provider's model is resolved through `modelFor(spec)`: `--model` (`runtimeModels` map via `setRuntimeModel`) → `router.models.<id>` in `~/.devpilot/config.json` → `spec.model` default. CLI-backed providers can use the `CLI_DEFAULT_MODEL` sentinel instead of a fixed model name when the signed-in CLI's own config should win.
- Pricing (for `devpilot generate --estimate`) is keyed by **model**, not provider, in `MODEL_PRICING` (`pricingFor`) — a model with no entry there and no `router.pricing.<model>` override in the user's config reports no cost rather than a wrong one; do not guess a price.
- Test seams: `setFetchForTests(f | null)` for HTTP, `setRunForTests(r | null)` for CLI-backed providers, `setRetryDelayForTests(ms | null)` to shrink backoff in tests. New provider tests belong in `tests/router-network.test.ts` (HTTP) or alongside the existing CLI-provider `describe` blocks there, following the exact `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` pattern already used for `anthropic`/`claude-code`/`codex-cli`/`gemini-cli`.
- `doctor` (`src/commands/doctor.ts`) auto-derives its provider status list from `PROVIDERS` and `availableProviders()` — a correctly added provider needs no separate `doctor` change to show up there.

## Task

1. State whether the new provider is a hosted API (needs `post()`/`postStream()` and an API key) or a keyless CLI (needs `runAsync` and a `binary` on PATH), and whether it's OpenAI-compatible (reuse `openAiCompatible`) or needs a bespoke request/response shape.
2. Write the new `ProviderSpec` entry for `PROVIDERS`, with `cost`/`speed`/`quality`/`contextTokens` set relative to at least two existing entries you name explicitly.
3. Implement `ask()` (and `askStream()` if the provider supports streaming) using the shared `post()`/`postStream()`/`runAsync` helpers — do not reimplement timeout or retry.
4. If it needs a key, confirm `needsKey: true` and that `verifyApiKey` will work against it (a free, tokenless request) so `devpilot auth`/`devpilot doctor --online` can validate it.
5. Add pricing to `MODEL_PRICING` only if you have a real published price to cite; otherwise leave it out and let `--estimate` report "no price on file."
6. Add tests to `tests/router-network.test.ts` covering: success, auth failure (401/403), rate limit/retry (429 or 5xx), and — if CLI-backed — the not-installed (`ENOENT`) case, following the existing `describe` block structure.
7. Do not invent a model name, host, or price not confirmed by the provider's real published API — if unsure, mark it as a TODO for the human to confirm rather than guessing.

## Output

The `ProviderSpec` addition to `src/providers/router.ts`, the `ask`/`askStream` implementation, and the new test cases in `tests/router-network.test.ts`, followed by the verification commands to run (`npm run lint`, `npm run build`, `npm run test:coverage`).

```
<paste the provider's name, API docs excerpt or CLI invocation, auth mechanism, and default model>
```
