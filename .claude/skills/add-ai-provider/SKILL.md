---
name: add-ai-provider
description: Use when adding a new AI provider (hosted API or keyless CLI) to the router in src/providers/router.ts.
---

# Add AI Provider

## When to use

Adding a new entry to `PROVIDERS` in `src/providers/router.ts` — a hosted API (like the existing `groq`/`deepseek`/`mistral`/`xai`/`openrouter` OpenAI-compatible providers) or a keyless CLI-backed provider (like `claude-code`/`codex-cli`/`gemini-cli`). Not for changing routing logic itself (`route()`), and not for artifact generation — that's `@.claude/skills/add-artifact-kind/SKILL.md`.

## Before you start

- @src/providers/router.ts — `ProviderSpec`, `post`/`postStream`, `classifyStatus`, `openAiCompatible`, `RETRYABLE_STATUS`, `MAX_ATTEMPTS`
- @tests/router-network.test.ts — retry/backoff/timeout test patterns using `setFetchForTests`/`setRunForTests`/`setRetryDelayForTests` + `vi.useFakeTimers()`
- @tests/ask-stream.test.ts — the streaming-provider test table (`groq`, `deepseek`, `mistral`, `xai`, `openrouter`)
- @CLAUDE.md — "no floating or misused promises", "Secrets must avoid `argv` when possible"

## Steps

1. Add a `ProviderSpec` to `PROVIDERS`: `id`, `name`, `model`, `cost`/`speed`/`quality`/`contextTokens` set _relative to existing entries_ (don't invent an absolute scale), `needsKey`, and `binary`/`parallel` if it's a CLI-backed provider.
2. For a hosted OpenAI-compatible API, reuse `openAiCompatible` the way `groq`/`deepseek`/`mistral`/`xai`/`openrouter` do — implement `ask()` via the shared `post()` helper and `askStream()` via `postStream()` with `openAiDelta`, rather than writing a new HTTP client.
3. For a keyless CLI-backed provider, follow the `claude-code`/`codex-cli`/`gemini-cli` pattern: spawn the binary via `runAsync`, pipe the prompt over **stdin**, never as an argv value.
4. If the model has a published per-million-token price, add it to `MODEL_PRICING` in `router.ts` — otherwise leave it out; `pricingFor`/`knowa generate --estimate` correctly reports "no price on file" rather than guessing.
5. No manual doctor wiring needed — `providerStatuses` in `src/commands/doctor.ts` iterates `PROVIDERS` automatically, so a new entry shows up in `knowa doctor` for free.
6. Add a network test to `tests/router-network.test.ts` (success, 401 → CliError with the `knowa auth <provider>` hint, retry-then-succeed on a transient status) and, if it streams, a case in `tests/ask-stream.test.ts`.

## Verification

Run in order: `npm run format`, `npm run lint`, `npm run build`, `npm run test:coverage` (watch `tests/router-network.test.ts` and `tests/ask-stream.test.ts`). `npm run test:e2e` is not required unless the change also touches `generate` or `cli.ts`.

## Done when

- [ ] The provider's `ask()`/`askStream()` go through the shared `post()`/`postStream()` retry/backoff/timeout path.
- [ ] No secret is ever placed in argv.
- [ ] A network test using `setFetchForTests`/`setRunForTests` (never a real network call) covers success and one failure mode.
- [ ] The full verification chain is green.

## Never

- Never bypass `post()`/`postStream()` with a raw `fetch` call — that loses retry, backoff, and `CliError` classification.
- Never add a real network call or real `setTimeout` delay to a test — use the seams and `vi.useFakeTimers()`.
- Never pass a secret as a CLI argument for a spawned binary.
