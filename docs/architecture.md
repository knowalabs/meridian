This is the module map for the Meridian CLI itself — the layers under `src/`, how a `meridian generate` run flows through them, and the invariants a change must not break. Read it before crossing a module boundary; for the day-to-day command list see [engineer-workflow.md](engineer-workflow.md), and for naming/style once you're inside a file see [conventions.md](conventions.md).

## Layers and responsibilities

| Layer                               | Key files                              | Responsibility                                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entrypoint                          | `src/index.ts`, `src/cli.ts`           | Node-version gate, global crash handlers (`uncaughtException`/`unhandledRejection`/`SIGINT` → `renderError`), the single Commander command tree (`buildCli`).                                                                                                                               |
| Interactive shell                   | `src/launcher.ts`                      | Bare-`meridian` TUI: arrow-key menu (`menuPrompt`), banner (`showBanner`), runs commands in-process via `buildCli({ exitOverride: true })` so a failing command never kills the menu loop.                                                                                                  |
| Commands                            | `src/commands/*.ts`                    | One thin orchestration module per command group (`ask.ts`, `auth.ts`, `doctor.ts`, `generate.ts`, `install.ts`, `mcp.ts`, `sync.ts`, `update.ts`) — parse/validate flags, call into `core`/`generate`/`providers`, format `--json`/human output via `log`.                                  |
| Cross-cutting infra                 | `src/core/*.ts`                        | `config.ts` (global config load/save + `coerceConfig`), `errors.ts` (`CliError`, `EXIT`, `renderError`), `exec.ts` (subprocess helpers), `fsx.ts` (`writeFileAtomic`, `backupFile`), `vault.ts` (secret storage), `paths.ts` (`meridianHome`), `plugin.ts` (shared `ToolPlugin` interface). |
| Target-project analysis (read-only) | `src/scan/*.ts`                        | `analyzer.ts` (`analyzeProject` → `ProjectAnalysis`), `git.ts` (`collectGitSignal`/`churnMap`), `ignore.ts` (shared gitignore matcher), `workspaces.ts` (monorepo detection).                                                                                                               |
| Generation pipeline                 | `src/generate/*.ts`                    | `digest.ts` (`buildDigest`), `artifacts.ts` (`ArtifactKind` contract, `isAllowedPath`), `pipeline.ts` (`dependencyWaves`, `runGenerate`), `manifest.ts` (drift/edit detection), `validate.ts` (claim-checking), `cache.ts` (codebase-review cache).                                         |
| AI routing                          | `src/providers/router.ts`              | Provider registry (`PROVIDERS`), selection (`route`/`pickProvider`), HTTP retry/backoff (`post`/`rawPost`/`classifyStatus`), CLI-provider dispatch.                                                                                                                                         |
| Rule mirroring                      | `src/rules/generators.ts`              | Renders `.meridian/rules.md` into `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/meridian.mdc`, `.github/copilot-instructions.md`.                                                                                                                                                   |
| Tool/MCP management                 | `src/plugins/tools.ts`, `src/mcp/*.ts` | Detecting/installing AI tool CLIs; the MCP server registry and per-tool config writer.                                                                                                                                                                                                      |

## Control and data flow

`meridian generate` (`src/commands/generate.ts` → `src/generate/pipeline.ts`'s `runGenerate`):

1. `analyzeProject` (`src/scan/analyzer.ts`) walks the _target_ project (respecting `src/scan/ignore.ts`) and produces a `ProjectAnalysis` — languages, frameworks, scripts, conventions, API routes, and the per-file `codeMap`.
2. `buildDigest` (`src/generate/digest.ts`) turns that analysis plus budgeted file excerpts into a text blob sized to the chosen provider's context window (`digestBudgetFor`); `serveFileRequests` can serve a bounded follow-up read when a review pass asks for a specific file.
3. `pickProvider`/`route` (`src/providers/router.ts`) select a provider; the digest is sent through `REVIEW_PROMPT` to produce a codebase review, cached per project/provider/model/digest by `src/generate/cache.ts`.
4. `dependencyWaves` (`src/generate/pipeline.ts`) groups `ARTIFACT_KINDS` (`src/generate/artifacts.ts`) so a kind only runs once every kind it `dependsOn` has produced its files; each kind's `prompt()` or `fallback()` runs, concurrency bounded by `concurrencyFor`.
5. `validateArtifacts` (`src/generate/validate.ts`) rejects claims the project contradicts (invented scripts, dead paths, malformed frontmatter); a failing kind gets one retry with the findings attached.
6. Every returned path is checked by `isAllowedPath` before `writeFileAtomic` (`src/core/fsx.ts`) writes it; `src/rules/generators.ts` is the only code that writes the five rule mirrors.
7. `src/generate/manifest.ts` records a per-file content signature (`signatureOf`) into `.meridian/manifest.json`, which `meridian sync` later reads via `fileStates`/`diffFingerprints` to decide what drifted versus what was hand-edited.

`meridian ask`/`meridian generate` provider calls both go through `src/providers/router.ts`'s `route()`/`post()` — never a provider's HTTP endpoint directly — so retry/backoff and error classification stay in one place.

## External dependencies and why

| Dependency                                                                        | Why                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `commander`                                                                       | The entire CLI command tree (`src/cli.ts`).                                             |
| `picocolors`                                                                      | Terminal color/formatting used throughout commands and the launcher.                    |
| `typescript`, `typescript-eslint`, `eslint`, `eslint-config-prettier`, `prettier` | Strict type-checking and lint/format enforcement (`tsconfig.json`, `eslint.config.js`). |
| `vitest`, `@vitest/coverage-v8`                                                   | Unit/e2e test runner and coverage gate (`vitest.config.ts`, `vitest.e2e.config.ts`).    |
| `tsx`                                                                             | Runs `src/index.ts` directly for `npm run dev` without a build step.                    |
| `@changesets/cli`                                                                 | Changelog/version discipline feeding `CHANGELOG.md` and releases.                       |

## Invariants a change must not break

- `isAllowedPath` (`src/generate/artifacts.ts`) is the only gate stopping AI-suggested content from writing outside the target project — any new write path must go through it.
- `src/generate/artifacts.ts` (the `ArtifactKind` contract) and `src/generate/pipeline.ts` (`dependencyWaves`) change together — one defines the shape, the other schedules it.
- Every provider in `src/providers/router.ts` must work behind a plain `ask(prompt: string)` string interface — the keyless CLI providers (`claude-code`, `codex-cli`, `gemini-cli`) cannot speak a structured protocol.
- `src/rules/generators.ts` is the sole writer of `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/meridian.mdc`, `.github/copilot-instructions.md`; nothing else may write those files.
- `src/scan/*` is read-only against the target project — nothing under it writes back.
- `.meridian/manifest.json` is written only by `src/generate/manifest.ts`; sync decisions must go through `signatureOf`/`fileStates`, not ad hoc hashing.

What this doc does _not_ cover: per-file naming/style rules (see [conventions.md](conventions.md)) and the operational read-before-write/report-a-bug obligations (see `.meridian/rules.md`).

## Related

- [conventions.md](conventions.md) — naming, imports, typing and error-handling rules once you're inside a file.
- [engineer-workflow.md](engineer-workflow.md) — the commands that exercise this architecture.
- [security.md](security.md) — the security-critical subset of this map (vault, artifact allowlist, MCP writes).
- `.meridian/rules.md` — the operational read-before-write and reporting obligations layered on top of this map.
