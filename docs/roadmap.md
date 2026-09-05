Where Meridian is actually headed, grounded only in evidence this repository shows — `CHANGELOG.md`, recent commit history, and half-built surfaces already in the code. Nothing here is invented; where the evidence stops, the item stops. Read this before adding something that would fight the project's stated direction.

## Rebranding and republishing

The product renamed twice in under a month — "rename the product from DevPilot to Knowa" (2026-08-05) then "Rename product from Knowa to Meridian" (2026-08-24) — and was republished under a brand-new npm scope, `@knowalabs/meridian`, restarting the version at `0.1.0` ("Republish as @knowalabs/meridian, starting from 0.1.0", 2026-09-04). `CHANGELOG.md`'s `0.1.1` entry is itself a same-day correction to the README the `0.1.0` republish shipped with. **Implication:** treat the product name, npm scope and repository URL as unstable metadata likely to move again — never hardcode them into generated examples or templates where reading `package.json` would do.

## Cloud Sync (`meridian login`)

`src/commands/update.ts`'s `loginCommand` explicitly states: "Cloud Sync is not available yet — it is on the roadmap, without a date," and describes its intended scope — "sync encrypted API keys, rules, prompts, MCP config and preferences across machines." This is very likely _why_ `src/core/vault.ts` already exposes secrets behind a single `Vault` interface with four interchangeable backends (Keychain, libsecret, DPAPI-wrapped file, plain file) rather than one hardcoded implementation. **Implication:** new work touching config, vault, or MCP storage should preserve that abstraction boundary rather than special-casing today's local file layout.

## The kit as an ongoing cost/tradeoff surface

The `Rigor` dial (`light`/`standard`/`strict`, `src/generate/artifacts.ts`) and `residentCost` reporting (`src/generate/manifest.ts`) show the generation pipeline moving from "dump a template" toward treating a generated kit's per-request token cost as a first-class, persisted setting that a refresh never silently re-decides. Recent commit history ("feat(generate): add a rigour dial, stop rules duplicating the docs, fix propagation", 2026-08-22) confirms this is active, not finished. **Implication:** a new artifact kind should plug into both the rigor dial and resident-cost accounting rather than reintroducing a flat, one-size-fits-all output.

## A growing artifact-kind graph

`dependencyWaves`/`dependsOn` (`src/generate/pipeline.ts`, `src/generate/artifacts.ts`) anticipates artifact kinds referencing each other's output — commands already delegate to the skills the `skills` kind just wrote. Recent commit history ("feat: implement dependency waves for artifact generation and enhance model selection", 2026-07-27) shows this is a deliberate, recent addition. **Implication:** a future artifact kind that needs another kind's output should declare it via `dependsOn`, not read the other kind's files off disk directly.

## Commercial framing

`business/growth-plan.md` exists alongside a marketing-restructured README (banner, badges, a quickstart-first reorganization per the `0.1.1` changelog entry) — signals of a shift from personal tool toward a product with commercial intent. Provenance-signed publishing and a real `SECURITY.md` are already in place ahead of that shift, not scrambled together after it.

## What this roadmap does not cover

This is not a committed timeline — none of the items above have dates. It also does not cover anything not evidenced in `CHANGELOG.md`, commit history, or an already-half-built module; a feature idea with no trace in the repo does not belong here.

## Related

- [engineering-standards.md](engineering-standards.md) — the maturity gaps this trajectory should close as it matures, not just extend.
- [tech-debt.md](tech-debt.md) — the rebranding-churn risk as a concrete debt entry.
