---
name: add-provider
description: Use when wiring a new AI provider (hosted API or keyless CLI) into the router so `meridian generate`/`ask`/`sync` can route to it.
---

# Add a provider

## When to use

Use when adding a new entry to the AI router — a hosted API (like anthropic/openai/google) or a keyless CLI tool (like claude-code/codex-cli/gemini-cli). Not for changing routing _policy_ (cost/speed/quality weighting) — that's already in `route()`/`pickProvider()` in `src/providers/router.ts` and rarely needs a new provider to touch it.

## Before you start

- @.meridian/rules.md — "Before touching `src/providers/router.ts`, read `post`/`rawPost`/`classifyStatus` end to end — the timeout-vs-retry distinction and the HTTP-vs-CLI provider split are load-bearing."
- `src/providers/router.ts` — the `ProviderSpec` interface, the `PROVIDERS` array, and one existing entry of the same kind you're adding (a hosted API like `anthropic`, or a keyless CLI like `claude-code`).
- `tests/router.test.ts` and `tests/router-network.test.ts` — the exact assertions a new provider must satisfy.

## Steps

1. Read `ProviderSpec` and the closest existing entry end to end: for an HTTP provider, read how it calls `post()`/`rawPost()`; for a CLI provider, read `claude-code`'s use of `runImpl`/stdin piping.
2. Add the new object to `PROVIDERS` with every required field: `id`, `name`, `model`, `cost`/`speed`/`quality` rank, `contextTokens`, `needsKey`. A keyless CLI provider also needs `binary` (the PATH executable) and `needsKey: false`; a hosted API needs `needsKey: true` and no `binary`.
3. Implement `ask(prompt, apiKey)` through the shared plumbing, never a fresh `fetch`/`spawn` call: HTTP providers go through `post()`/`rawPost()` so they inherit retry/backoff/timeout/`classifyStatus` handling for free; CLI providers go through `runImpl` (`runAsync`), piping the prompt over **stdin, not argv** — the same reason `claude-code`/`codex-cli`/`gemini-cli` do it (argv has size limits a whole codebase digest would exceed). `ask` must accept nothing beyond a plain prompt string — a structured protocol added for one provider must stay optional for the rest.
4. If the provider ships a stable model catalogue, add `models: ModelOption[]`, each `{ id, note }`, and make sure the array includes the provider's own default `model` (a shipped catalogue that omits it offers no way back to the default). Leave `models` undefined for an unenumerable or per-machine catalogue (see `ollama`, discovered live via `installedOllamaModels`).
5. Only add a `MODEL_PRICING` entry if you have a real, current list price. Leave it absent otherwise — `--estimate` reports "unknown cost" instead of a wrong number by design; a guessed price is worse than none.
6. Add tests: extend `tests/router.test.ts`'s "registry lists every supported provider" id list and its "model catalogue" checks, and add a `tests/router-network.test.ts` case exercising `ask()` (via `setFetchForTests` for HTTP, `setRunForTests` for CLI) covering at least one success path and one failure path.

## Verification

- `npm run lint`
- `npx vitest run tests/router.test.ts`
- `npx vitest run tests/router-network.test.ts`
- Full chain (`npm run lint` → `prettier --check` → `build` → `test:coverage` → `test:e2e`) before calling it done.

## Done when

- [ ] `PROVIDERS` includes the new entry with every `ProviderSpec` field the type requires.
- [ ] `tests/router.test.ts`'s provider-list and model-catalogue assertions pass with the new id included.
- [ ] `ask()` goes through `post()`/`rawPost()` or `runImpl`, never a bare `fetch`/`spawn`.
- [ ] A pricing entry exists only if it is a real, sourced number.

## Never

- Never give a provider an `ask` signature beyond `(prompt: string, apiKey: string)` — it would break the three keyless CLI providers, which only understand a text prompt.
- Never call `fetch` or spawn a process directly instead of `post()`/`rawPost()`/`runImpl` — that silently drops retry, backoff and timeout handling.
- Never put a secret in argv when shelling out to a CLI provider — pipe it (or the prompt) over stdin.
- Never guess a `MODEL_PRICING` number — an absent price is honest; a wrong one is not.
