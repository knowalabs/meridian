The twelve AI providers behind `src/providers/router.ts`'s router, in one place — for adding a new provider, comparing routing behavior, or debugging why `generate`/`ask` picked the one it did. Read this before changing anything in `PROVIDERS`. For the retry/timeout mechanics all of them share, see [architecture.md](architecture.md)'s invariants.

## Registry

| Provider id   | Needs key | Notes                                                                                                                                                           |
| ------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`   | Yes       | Default model `claude-sonnet-5`; has a `MODEL_PRICING` entry.                                                                                                   |
| `openai`      | Yes       | Hosted API.                                                                                                                                                     |
| `google`      | Yes       | Default model `gemini-2.5-flash`; has a `MODEL_PRICING` entry.                                                                                                  |
| `groq`        | Yes       | Hosted API.                                                                                                                                                     |
| `deepseek`    | Yes       | Hosted API.                                                                                                                                                     |
| `mistral`     | Yes       | Hosted API.                                                                                                                                                     |
| `xai`         | Yes       | Hosted API.                                                                                                                                                     |
| `openrouter`  | Yes       | Catalogue too large to enumerate — no shipped `models` list (`ProviderSpec.models` omitted deliberately).                                                       |
| `ollama`      | No        | Local daemon; binary `ollama`. Its model catalogue is discovered live from `ollama list` (`installedOllamaModels`) rather than shipped, since it's per-machine. |
| `claude-code` | No        | Keyless CLI; binary `claude`, runs `claude -p` with the prompt piped over stdin (never argv).                                                                   |
| `codex-cli`   | No        | Keyless CLI; binary `codex`, runs `codex exec -` in a read-only sandbox; prefers a `-o` last-message file over noisy stdout.                                    |
| `gemini-cli`  | No        | Keyless CLI; binary `gemini`.                                                                                                                                   |

Every `ProviderSpec` (`src/providers/router.ts`) declares `cost`/`speed`/`quality`/`contextTokens` rankings the router (`route()`) uses to pick a default when no `--provider` or saved preference is set — quality wins ties, cost wins when `router.optimize` is `"cost"`, and a provider whose `contextTokens` can't fit the prompt is excluded outright.

## Model selection

- `modelFor(spec)` resolves in order: a per-process `--model` override (`setRuntimeModel`), then `router.models.<id>` in `~/.meridian/config.json`, then the provider's shipped default.
- `modelsFor(spec)` (used by the interactive picker) always puts the model currently in play first so pressing Enter keeps it, and always accepts free-text entry — the shipped `models` catalogue is a starting point, never a whitelist, since providers ship models faster than Meridian releases.
- `CLI_DEFAULT_MODEL` is the sentinel for CLI-backed providers whose model naming churns with the underlying tool's own configuration.

## Retry and failure classification

All HTTP-backed providers share `post`/`rawPost`/`classifyStatus`:

- Retried (up to `MAX_ATTEMPTS = 3`, exponential backoff, honoring `Retry-After`): HTTP 408/425/429/500/502/503/504, and a dropped connection (`TransientNetworkError`).
- Never retried: a timeout (`AbortController`-driven — retrying a hung provider only multiplies the wait, so it maps straight to a `CliError`), and any 4xx that means "the request itself is wrong" (400, 401/403 → auth hint, 404 → model-not-found hint).

## Cost estimation gap

`MODEL_PRICING` (`src/providers/router.ts`) has exactly two entries: `claude-sonnet-5` and `gemini-2.5-flash`. `meridian generate --estimate` reports "unknown cost" for every other model rather than guessing — correct behavior, but a real coverage gap tracked in [tech-debt.md](tech-debt.md). Users can add their own entries under `router.pricing.<model>` in `~/.meridian/config.json`, which always wins over the built-in table (`pricingFor`).

## Related

- [architecture.md](architecture.md) — where the router sits relative to `commands/ask.ts` and `generate/pipeline.ts`.
- [tech-debt.md](tech-debt.md) — the `MODEL_PRICING` coverage gap as a tracked debt item.
