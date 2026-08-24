# Provider matrix

The AI providers `src/providers/router.ts` can route `meridian generate`, `meridian sync` and `meridian ask` to, how each is authenticated, and provider-specific behavior worth knowing before adding or debugging one. Read this before touching `PROVIDERS` in `src/providers/router.ts` or `src/providers/router.test.ts`/`tests/router-network.test.ts`/`tests/ask-stream.test.ts`. Not covered: which provider a given run actually picks — that's `route()`'s cost/speed/quality/context-size logic, described structurally below, not as fixed numbers this doc would go stale against.

## Providers

| ID            | Kind                          | Auth                           | Host / binary                       | Notes                                                                                                                                   |
| ------------- | ----------------------------- | ------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`   | Hosted API                    | API key (vault)                | Anthropic API                       | Default model `claude-sonnet-5` (`MODEL_PRICING` and `modelFor` tests in `tests/router-network.test.ts`).                               |
| `openai`      | Hosted API                    | API key (vault)                | OpenAI API                          | —                                                                                                                                       |
| `google`      | Hosted API                    | API key (vault)                | Google API                          | Default model `gemini-2.5-flash` per `MODEL_PRICING` in `src/providers/router.ts`.                                                      |
| `groq`        | Hosted API, OpenAI-compatible | API key (vault)                | `api.groq.com`, `/chat/completions` | Shares the OpenAI-compatible client (`openAiCompatible`), `Bearer` auth header.                                                         |
| `deepseek`    | Hosted API, OpenAI-compatible | API key (vault)                | `api.deepseek.com`                  | Same shared client.                                                                                                                     |
| `mistral`     | Hosted API, OpenAI-compatible | API key (vault)                | `api.mistral.ai`                    | Same shared client.                                                                                                                     |
| `xai`         | Hosted API, OpenAI-compatible | API key (vault)                | `api.x.ai`                          | Grok, same shared client.                                                                                                               |
| `openrouter`  | Hosted API, OpenAI-compatible | API key (vault)                | `openrouter.ai`                     | Same shared client.                                                                                                                     |
| `ollama`      | Local                         | none                           | local daemon                        | Free, local; network errors map to a "start Ollama with `ollama serve`" hint (`post()`'s error mapping in `src/providers/router.ts`).   |
| `claude-code` | Keyless CLI                   | signed-in CLI                  | `claude` binary                     | Spawned via `runAsync`, prompt piped over **stdin**, args include `-p`; model override via `router.models['claude-code']`.              |
| `codex-cli`   | Keyless CLI                   | signed-in CLI                  | `codex` binary                      | `codex exec -` + `--skip-git-repo-check`, stdin prompt; prefers the `-o` last-message file over stdout, falls back to stdout if absent. |
| `gemini-cli`  | Keyless CLI                   | signed-in CLI (Google account) | `gemini` binary                     | Stdin prompt, stdout answer.                                                                                                            |

## Selection order (no key required)

Per the README, when no API key is configured Meridian tries, in order of quality: `claude-code` (Claude Pro/Max via `claude -p`), `codex-cli` (ChatGPT plan via `codex exec`, read-only sandbox), `gemini-cli` (Google account). `route()` (`src/providers/router.ts`) otherwise picks among `availableProviders()` by each `ProviderSpec`'s relative `cost`/`speed`/`quality`/`contextTokens` rankings (lower = better/cheaper/faster per the field comments in the `ProviderSpec` interface) and the user's `router.prefer`/`router.optimize` config.

## Model resolution

`modelFor(spec)` resolves in this order: a per-run `--model` override (`setRuntimeModel`), then `router.models.<id>` in `~/.meridian/config.json`, then the provider's own default `model`. CLI-backed providers use the sentinel `CLI_DEFAULT_MODEL = 'cli-default'` — "use whatever the signed-in CLI is configured with" — unless explicitly overridden.

## Network resilience

All hosted-API calls go through `post()`/`postStream()` in `src/providers/router.ts`: `DEFAULT_TIMEOUT_MS = 60_000`, up to `MAX_ATTEMPTS = 3` for `RETRYABLE_STATUS` (`408, 425, 429, 500, 502, 503, 504`) with exponential backoff (`backoffFor`) honoring a `Retry-After` header (`retryAfterMs`, capped at 30s); 4xx errors outside that set are never retried. `401`/`403` map to an auth-failure `CliError` hinting `meridian auth <provider>`; `404` hints at a retired model, pointing at `router.models.<id>`. Streaming (`postStream`) never retries — once the first byte reaches the terminal, replaying would print the answer twice.

## Adding a provider

Add an entry to `PROVIDERS` in `src/providers/router.ts` with `cost`/`speed`/`quality`/`contextTokens` set relative to the existing entries, and cover it in `tests/router-network.test.ts` or `tests/ask-stream.test.ts` alongside the others.

## Related

[cli-reference.md](cli-reference.md) for the `-p/--provider`/`-m/--model` flags that select among these, [architecture.md](architecture.md) for where `route()`'s output feeds into `meridian generate`'s pipeline.
