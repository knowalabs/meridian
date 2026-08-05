# Codebase Review — @sonalsithara/knowa

## What this project is — purpose and domain, in the project's own terms

Knowa (`@sonalsithara/knowa`) is a Node.js/TypeScript CLI, installed globally as `knowa`, whose stated mission is "one command to set up every AI coding tool on any machine." It is a **meta-tool for AI-assistant tooling**: rather than being an AI application itself, it configures, feeds, and maintains the surrounding infrastructure that other AI coding tools (Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot) depend on.

Concretely, its domain covers four things: (1) installing and configuring AI coding tools across macOS/Windows/Linux, (2) securely storing provider API keys in the OS-native secret store, (3) statically analyzing a _target_ codebase and using AI to generate a complete "AI kit" — rules files, subagents, skills, slash commands, harness permissions, prompts, and a docs suite — tailored to that project, and (4) keeping that generated kit alive over time via drift detection and refresh (`knowa sync`). The README frames this as turning AI configuration from a hand-authored, quickly-stale artifact into a living one, "you never hand-write an AI config file again."

Per `CLAUDE.md`, this repo carefully distinguishes "the target project" (what `knowa generate` scans, e.g. `src/scan/analyzer.ts`'s subject) from "this repo" (Knowa's own source) — the codebase dogfoods itself, generating its own `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`README_AI.md` as tracked output.

## Architecture — modules, responsibilities, and control/data flow

The flagship path is `knowa generate`, orchestrated by `runGenerate` in `src/generate/pipeline.ts`:

```
src/scan/analyzer.ts (analyzeProject)
        ↓ ProjectAnalysis
src/generate/digest.ts (buildDigest)
        ↓ ProjectDigest (text + code map + excerpts)
src/providers/router.ts (route/pickProvider)
        ↓ ProviderSpec.ask(prompt, apiKey)
src/generate/artifacts.ts (ARTIFACT_KINDS: prompt/fallback per kind)
        ↓ ArtifactFile[] (parsed via parseFileBlocks, validated via isAllowedPath)
src/core/fsx.ts (writeFileAtomic)
        ↓
src/rules/generators.ts (generateRules — mirrors rules.md into CLAUDE.md/AGENTS.md/GEMINI.md/…)
```

- **`src/index.ts`** — process entry point only: Node-version gate, global `uncaughtException`/`unhandledRejection`/`SIGINT` handlers, and dispatch to either `launcher.ts` (bare `knowa` in a TTY) or `cli.ts` (`buildCli().parseAsync`). Notably imports `./core/colorflag.js` first, before `renderError`/`buildCli`, to set color state before `picocolors` is loaded elsewhere.
- **`src/cli.ts`** — builds the Commander program (`buildCli`), registers every subcommand (`doctor`, `install`/`uninstall`, `auth`/`keys`, `generate`, `sync`, `mcp`, `ask`, `router`, `update`, `login`) and attaches global flags (`--verbose`, `-q/--quiet`, `--json`, `--no-color`) recursively via `addGlobalFlags`. Every action uses a `done(code)` closure that sets `process.exitCode` rather than calling `process.exit()`, so the interactive launcher can run commands in-process (see `src/launcher.ts`'s `runCommandLine`).
- **`src/launcher.ts`** — the interactive TUI (`runInteractive`, `menuPrompt`, `showBanner`/`showWelcome`, `tokenize`). Runs `buildCli({ exitOverride: true })` in-process per keystroke-selected command, catching `CommanderError` so one failing command never kills the menu loop.
- **`src/commands/*.ts`** — thin adapters: `doctor.ts`, `install.ts`, `auth.ts`, `generate.ts`, `sync.ts`, `mcp.ts`, `ask.ts`, `update.ts`. Each parses/validates CLI input and calls into `core`/`generate`/`providers`/`scan`, returning an exit code — no `process.exit()` calls anywhere in this layer.
- **`src/core/`** — cross-cutting infra: `errors.ts` (`CliError`, `renderError`, `EXIT`), `logger.ts` (`log`, `configureLogger`, `jsonMode`), `config.ts` (`loadConfig`/`saveConfig`/`RouterConfig`), `vault.ts` (multi-backend secret storage — `KeychainVault`, `SecretToolVault`, `FileVault`, `DpapiProtector`, `PlainProtector`), `fsx.ts` (`writeFileAtomic`, `backupFile`, `readJsonFile`), `paths.ts` (`knowaHome`, `ensureHome`), `exec.ts` (`run`/`runAsync`/`which`), `spinner.ts`, `pkg.ts` (`VERSION`), `prompt.ts` (interactive prompts, `didYouMean`/`levenshtein`), `validate.ts`, `colorflag.ts`.
- **`src/scan/`** — read-only static analysis of the target project: `analyzer.ts` (`analyzeProject`, code-map symbol extraction, `renderContextMarkdown`/`renderArchitectureMarkdown`), `ignore.ts` (`createIgnore` — the single ignore-matching authority, gitignore-aware), `workspaces.ts` (`detectWorkspaces` for npm/yarn/pnpm/Lerna/Cargo/go.work monorepos).
- **`src/generate/`** — the AI-kit pipeline: `digest.ts` (`buildDigest` — assembles the project digest under a token budget), `artifacts.ts` (`ARTIFACT_KINDS`, `isAllowedPath`, `parseFileBlocks`, `FORMAT_SPEC`, `commonPrompt`), `pipeline.ts` (`runGenerate`, `generateKind`, `pickProvider`, `estimateGenerate`, `concurrencyFor`), `manifest.ts` (`KitManifest`, `fingerprintOf`, `diffFingerprints`, `fileStates` — powers `knowa sync`), `cache.ts` (codebase-review caching keyed by project/provider/model/digest).
- **`src/rules/generators.ts`** — mirrors `.knowa/rules.md` into every AI tool's native config file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, etc.) via `generateRules`/`RULE_TARGETS`.
- **`src/providers/router.ts`** — `PROVIDERS: ProviderSpec[]`, `route()`, `modelFor()`, shared HTTP `post()`/`postStream()` with timeout/retry/backoff/error classification (`classifyStatus`), CLI-backed providers (`claude-code`, `codex-cli`, `gemini-cli`) spawned via `runAsync`.
- **`src/mcp/`** (`registry.ts` — `MCP_REGISTRY`, `searchMcp`; `configure.ts` — `addServer`/`removeServer`/`listInstalled` across tool configs) + `src/commands/mcp.ts` — the MCP server marketplace.
- **`src/plugins/`** — `tools.ts`: per-tool install/detect/config logic (`TOOL_SPECS`, `buildRegistry`, platform-specific install hints for brew/winget) used by `install`/`doctor`/`uninstall`.

Control flow for `generate`: `commands/generate.ts` → `pipeline.runGenerate` → `scan/analyzer.analyzeProject` (read target project) → `generate/digest.buildDigest` (build AI input) → `providers/router` (pick + call provider) → `generate/artifacts` (prompt construction, response parsing, path validation) → `core/fsx.writeFileAtomic` (write) → `rules/generators.generateRules` (propagate) → `generate/manifest.writeManifest` (record fingerprint for `sync`).

## Core concepts — the domain model

- **`ProjectAnalysis`** (`src/scan/analyzer.ts`) — the central read-only model of a scanned target project: `name`, `languages`, `dependencies`/`devDependencies`, `frameworks`, `scripts`/`scriptRunner`, `tree`, `conventions`, `apiRoutes`, `codeMap: CodeMapEntry[]`, `totalFiles`, `workspaces: WorkspaceInfo | null`. Produced by `analyzeProject(root, ignore)`.
- **`CodeMapEntry`** — `{ file, symbols }`, built by `extractFileSymbols` using per-language-family regex matchers (`JS_MATCHERS`, `PY_MATCHERS`, `GO_MATCHERS`, `RUST_MATCHERS`, `JVM_MATCHERS`, `SWIFT_MATCHERS`, `RUBY_MATCHERS`, `PHP_MATCHERS`, `DART_MATCHERS`, `ELIXIR_MATCHERS`, `CPP_MATCHERS`) so AI prompts can see every class/function/interface/type even for files that don't fit the digest's excerpt budget.
- **`WorkspaceInfo`/`WorkspacePackage`** (`src/scan/workspaces.ts`) — monorepo detection across npm/yarn/pnpm/Lerna/Cargo/`go.work`, each package with its own `name`, `scripts`, `dependencies`. Feeds `ProjectAnalysis.workspaces`.
- **`ProjectDigest`** (`src/generate/digest.ts`) — `buildDigest`'s output: the text blob (layout, code map, file excerpts) sent to AI, budgeted via `digestBudgetFor` and sampled via `sampleSources`.
- **`ArtifactKind`** (`src/generate/artifacts.ts`) — the unit of generation: `{ id, name, description, allowedPaths, alwaysOverwrite?, minFiles?, requiredFiles?, optIn?, prompt(digest), fallback(analysis) }`. `ARTIFACT_KINDS` enumerates `rules`, `agents`, `skills`, `commands`, `prompts`, `docs`, `harness`, and opt-in `ci`. Every kind must supply both an AI `prompt` and a static `fallback`, enforced by the "static fallbacks" test in `tests/generate.test.ts`.
- **`ArtifactFile`** — `{ file, content }`, the atomic unit written to disk; produced either by an AI response parsed with `parseFileBlocks` (the `<<<FILE path>>> … <<<END>>>` protocol) or by a kind's static `fallback`.
- **`isAllowedPath(file, allowed)`** — the single security gate validating any AI-suggested or fallback-suggested path against a kind's `allowedPaths`, blocking absolute paths, Windows drive letters, and `..` traversal.
- **`ProviderSpec`** (`src/providers/router.ts`) — `{ id, name, model, cost, speed, quality, contextTokens, needsKey, binary?, parallel?, ask(), askStream?() }`, the abstraction over both hosted-API providers (Anthropic, OpenAI, Groq, DeepSeek, Mistral, xAI, OpenRouter, Google, Ollama) and CLI-backed keyless providers (`claude-code`, `codex-cli`, `gemini-cli`). `route()` picks among `availableProviders()` by cost/speed/quality/context preference.
- **`Vault`** (`src/core/vault.ts`) — `{ backend, set, get, delete, list }` interface implemented per-platform: `KeychainVault` (macOS `security`), `SecretToolVault` (Linux `secret-tool`/libsecret), `FileVault` (AES-256-GCM encrypted fallback, key wrapped by `DpapiProtector` on Windows or left as hex via `PlainProtector` elsewhere).
- **`KitManifest`/`KitFingerprint`** (`src/generate/manifest.ts`) — the record `knowa generate` writes (`.knowa/manifest.json`): a fingerprint of the project state plus a sha256 per written file. `diffFingerprints` and `fileStates` (clean/edited/missing) power `knowa sync`'s drift detection and hand-edit preservation.
- **`GenerateOptions`/`GenerateResult`/`FileResult`** (`src/generate/pipeline.ts`) — the pipeline's I/O contract: options in (root, kinds, provider, force, dryRun, noAi, refresh, concurrency, noCache), result out (files with `action: 'written'|'skipped-exists'|'planned'|'rejected-path'`, `propagated`, `failed`, `aborted?`, `reviewFromCache?`).
- **`CliError`** (`src/core/errors.ts`) — the sole error type surfaced to users, always carrying an actionable `hint`.
- **`ToolPlugin`/`PluginRegistry`** (`src/core/plugin.ts`, `src/plugins/tools.ts`) — per-AI-tool install/detect/doctor abstraction (`TOOL_SPECS`, `buildRegistry`) used uniformly by `install`, `doctor`, `uninstall`.
- **`McpServerSpec`** (`src/mcp/registry.ts`) — the MCP marketplace entry type, resolved into per-tool config writes by `src/mcp/configure.ts`.

## Conventions & idioms

- **Explicit `.js` extensions on relative imports** despite `.ts` source, per NodeNext resolution — e.g. `import './core/colorflag.js'` in `src/index.ts`.
- **`CliError` with a `hint` for every user-facing failure** — see `src/providers/router.ts`'s `classifyStatus` (`hint: 'Run "knowa auth ${ctx.provider}"...'`) and `src/core/vault.ts`'s `readAll()` catch block.
- **Test seams instead of a mocking library** for side-effecting singletons — `setFetchForTests`/`setRunForTests`/`setRetryDelayForTests` in `src/providers/router.ts`, exercised in `tests/router-network.test.ts` with `vi.useFakeTimers()`.
- **Atomic, permissioned file writes** — `writeFileAtomic` (`src/core/fsx.ts`) used everywhere generated content or secrets are written; `mode: 0o600` explicitly for vault files (`indexWrite`, `FileVault.masterKey`/`writeAll` in `src/core/vault.ts`).
- **Secrets avoid argv where possible** — `KeychainVault.set` tries `security -i` (stdin) before falling back to argv; `SecretToolVault.set` always uses stdin (`src/core/vault.ts`).
- **No raw `process.exit()` in commands** — every command action returns a number and `src/cli.ts`'s `done()` closure assigns `process.exitCode`, so `src/launcher.ts` can run commands in-process without killing the TUI.
- **`done()`-wrapped Commander actions with `.action(async (...) => done(await xCommand(...)))`** — consistent shape across every registration in `src/cli.ts`.
- **UPPER_SNAKE_CASE module constants** — `PROVIDERS`, `ARTIFACT_KINDS`, `FORMAT_SPEC`, `DEFAULT_TIMEOUT_MS`, `MCP_REGISTRY`, `TOOL_SPECS`, `RULE_TARGETS`, `DEFAULT_RULES`.
- **Fail-closed AI generation** — `generateKind` in `src/generate/pipeline.ts`: a failed/incomplete AI response after one retry writes nothing and marks the kind `failed`, never silently substituting the static fallback mid-run (explicitly called out as a must-preserve invariant in `CLAUDE.md`).
- **Ordered retry/backoff for transient network failures** — `RETRYABLE_STATUS` set, `MAX_ATTEMPTS = 3`, exponential `backoffFor`, `Retry-After` honored via `retryAfterMs`, all in `src/providers/router.ts`; 4xx "your request is wrong" errors are never retried.
- **Read-only vs. write-capable module boundary strictly enforced** — `src/scan/analyzer.ts` never writes; only `src/generate/` + `src/rules/generators.ts` write generated output, per `CLAUDE.md`.
- **Ignore logic centralized in one matcher** — `src/scan/ignore.ts`'s `createIgnore`, shared by the analyzer's walk, the layout tree, and digest sampling, replacing what CHANGELOG 0.13.0 describes as three previously-disagreeing ignore lists.

## Testing & verification

- **Framework**: Vitest. Unit/integration tests in `tests/*.test.ts` (one file per module area: `analyzer`, `commands`, `config`, `doctor`, `errors`, `fsx`, `generate`, `ignore`, `launcher`, `mcp`, `platform`, `plugins`, `prompt`, `router`, `router-network`, `rules`, `sync`, `update-ask`, `vault`, `vault-backends`, `workspaces`). E2E tests in `tests/e2e/` (`workflows.test.ts`, `helpers.ts`) using a separately built CLI binary.
- **Sandboxing**: tests set `process.env.KNOWA_HOME` to a temp dir and `process.env.KNOWA_VAULT = 'file'`, cleaned up in `afterEach` with `fs.rmSync(..., { recursive: true, force: true })` — see `tests/doctor.test.ts`, `tests/commands.test.ts`, `tests/sync.test.ts`.
- **Provider-network mocking**: `setFetchForTests`/`setRunForTests` plus `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`, never real `setTimeout`/network — `tests/router-network.test.ts`, `tests/ask-stream.test.ts`.
- **Invariant tests**: `describe('isAllowedPath')` / `describe('parseFileBlocks')` in `tests/generate.test.ts`; `describe('static fallbacks')` asserts every `ArtifactKind.fallback()` output stays inside its own `allowedPaths`.
- **Coverage thresholds** (`vitest.config.ts`): 70% lines / 60% branches over `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts` (human/e2e-exercised, not unit-tested).
- **Exact commands**: `npm run format` (Prettier check), `npm run lint` (`eslint src tests`), `npm run build` (`tsc -p tsconfig.build.json`), `npm run test:coverage` (`vitest run --coverage`), `npm run test:e2e` (`pretest:e2e` builds first, then `vitest run --config vitest.e2e.config.ts`) — this exact order mirrors `.github/workflows/ci.yml`'s job steps.

## Gotchas

- **`src/index.ts`'s `colorflag.js` import must stay first** — it mutates `NO_COLOR` before `picocolors` (loaded almost everywhere else) reads color support at module-load time; reordering silently breaks `--no-color`.
- **Commands must never call `process.exit()`** — `src/launcher.ts` runs commands in-process via `buildCli({ exitOverride: true }).parseAsync`; a raw exit call would kill the whole interactive TUI session after one action.
- **AI generation is fail-closed by design** — a partial/failed AI response for a kind writes _nothing_, so re-running `knowa generate` is the recovery path, not a fallback to templates mid-run (`generateKind` in `src/generate/pipeline.ts`).
- **`isAllowedPath` is the only thing standing between an AI response and writing outside the project** (absolute paths, `C:\` drive letters, `../` escapes) — any new artifact kind or path-construction code must route through it, never bypass it.
- **Windows DPAPI vault (`DpapiProtector`) shells out to PowerShell over stdin (base64), by design** — passing secrets as PowerShell argv is explicitly forbidden per `CLAUDE.md`; the class also intentionally keeps a legacy plain-hex fallback in `unprotect()` for keys stored before the `dpapi:` prefix existed — do not remove it.
- **Publish gating in `.github/workflows/ci.yml` is a hard boundary** — the tag-vs-`package.json`-version check and `refs/tags/v*` trigger must not be touched without explicit confirmation; `npm publish` and tag pushes must never be run from an assistant session.
- **Generated files in _this_ repo are dogfooded output, not hand-authored** — `.knowa/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `README_AI.md` at the repo root are `knowa generate` output on Knowa's own source; editing them directly is a trap — the generator (`src/rules/generators.ts`, `src/generate/artifacts.ts`) is the actual source of truth.
- **`noUncheckedIndexedAccess` is on** — every indexed access (`arr[i]`, `record[key]`) types as possibly-`undefined`; the codebase leans on non-null assertions (`match[1]!`) after regex matches rather than optional chaining everywhere, which is idiomatic here but easy to get wrong in new code.
- **Digest/prompt token budgets are per-provider and dynamic** (`digestBudgetFor`, `ASSUMED_OUTPUT_TOKENS`) — changing artifact prompt length affects the `--estimate` cost model in `src/generate/pipeline.ts`, which is unit-tested against specific token/char assumptions.

## Maturity & gaps

Measured against a professional/enterprise Node CLI baseline, this project is well above average for its category:

- **Testing**: broad and deep — 20+ unit/integration test files plus a dedicated e2e suite exercising the built binary end-to-end (`tests/e2e/workflows.test.ts` covers vault round-trips, corrupt-vault recovery, `generate` idempotency, `sync` drift/refresh/hand-edit preservation, MCP install/remove, and `--quiet`/`--json` stream discipline). Coverage gates are enforced numerically (70%/60%), not aspirational.
- **CI**: `.github/workflows/ci.yml` runs a 3×3 OS/Node matrix (ubuntu/macos/windows × 18/20/22), the full lint→format→build→coverage→e2e chain, and gates `npm publish` behind an explicit tag-vs-version check with provenance (`id-token: write`, `npm publish --provenance`).
- **Security posture**: secrets never touch argv where avoidable (stdin-based `security -i`/`secret-tool`), AES-256-GCM encrypted file-vault fallback with DPAPI wrapping on Windows, `0o600` file modes, an explicit AI-output path allowlist (`isAllowedPath`) guarding against adversarial/malformed model responses, and generated harness config (`.claude/settings.json`) that denies reads of `.env`/key files by construction.
- **Error handling**: uniform `CliError` with actionable hints throughout; network calls have real retry/backoff/timeout semantics distinguishing transient failures from permanent ones (`classifyStatus`, `RETRYABLE_STATUS`).
- **Release discipline**: `@changesets/cli` is a dev dependency and `CHANGELOG.md` is detailed and structured (Minor Changes per release, each explaining user-facing motivation) — this is changeset-driven versioning done properly.
- **Documentation**: README is thorough (commands table, global flags, cost estimation, sync lifecycle, security model); the repo also generates its own `docs/` suite via its own tool (dogfooding), plus a separate `Knowa_Docs/` product-planning tree (`01-product-vision.md` through `05-monetization.md`) that most CLIs of this size lack.

Named gaps, all visible in the digest itself:

- **No `SECURITY.md`, `CODEOWNERS`, or dependency-scanning workflow** are listed among the repo's own top-level files or `.github/workflows/` (the digest layout shows only `ci.yml` under `.github/workflows/` and `copilot-instructions.md` at `.github/` root) — ironic given `src/generate/digest.ts` explicitly reads `SECURITY.md`/`CODEOWNERS` _from target projects_ and Knowa's own `raisingTheBar()` heuristic in `src/generate/artifacts.ts` would flag their absence as a gap in any other project it scanned.
- **No dependency-audit or Dependabot/Renovate config** appears in the digest's file listing — dependency hygiene is manual.
- **`src/launcher.ts` is explicitly excluded from coverage thresholds** (`vitest.config.ts`) — a deliberate, documented tradeoff (human/e2e-exercised), but it means the interactive TUI's ~300 lines of state machine (menu filtering, keypress handling, raw-mode terminal control) carry no unit-test safety net.
- **`knowa login` / Cloud Sync is a stub** — `src/commands/update.ts`'s `loginCommand` and the README both flag this as "on the roadmap, not available yet," i.e., a partially-scaffolded feature surface (a registered CLI command with no working implementation behind it).

## Trajectory — where this project is headed

The evidence points at three converging directions:

1. **From single-repo to monorepo-native.** CHANGELOG 0.13.0 added full workspace detection (npm/yarn/pnpm/Lerna/Cargo/`go.work`) with per-package scripts/dependencies flowing into every generated artifact ("say which package a rule or step applies to"). This is a maturing, not finished, direction — `tests/workspaces.test.ts` and `src/scan/workspaces.ts` show the mechanism is solid, but it's recent (one minor version back from `docs/` suite work), suggesting monorepo edge cases (nested workspaces, mixed-tool repos) are still being hardened.
2. **From free-form AI output to a structured, enforced artifact contract.** The most recent CHANGELOG entry (0.15.0, current version per `package.json`) is explicitly about this: "Generated artifacts now follow a real contract instead of being free-form markdown" — subagents now require `model:`/`tools:` frontmatter for least-privilege, skills follow a fixed `When to use`/`Steps`/`Verification`/`Done when` shape, docs must cite the file proving each claim. This is the project tightening its own output quality bar release-over-release, and `commonPrompt()` in `src/generate/artifacts.ts` (with its "Cover the core concepts," "Ground every non-obvious claim in evidence," and "Cross-reference the rest of the kit" instructions) is the current high-water mark of that effort.
3. **From "generate once" to "living kit."** 0.12.0 introduced `knowa sync` and the manifest system; 0.13.0 added caching, concurrency, and cost estimation to make repeated runs fast and cheap; 0.14.0 turned `doctor` into a real health check (including project-kit staleness); 0.15.0 raises what gets generated in the first place. The throughline across four consecutive minor versions is: **the AI kit should behave like a build artifact** — reproducible, diffable, incrementally refreshable, cost-estimable before you run it, and safe to regenerate without destroying hand edits.

The explicit stub for **Cloud Sync** (`knowa login`, README: "on the roadmap, not available yet") signals the next major direction: today `sync` is purely local/manifest-based; a cloud-backed sync (team-shared kits, cross-machine state) is anticipated infrastructure not yet built. Any new module should assume a future authenticated-account layer is coming and avoid assumptions that key/vault/config state is purely single-machine-local.

The `Raising the bar` mechanism (`raisingTheBar()` in `src/generate/artifacts.ts`, and the parallel "Maturity & gaps"/"Trajectory" sections this very review is structured around, per `REVIEW_PROMPT` in `src/generate/pipeline.ts`) shows the project treats _its own_ dogfooded output as a proof of concept for the enterprise-grade standard it wants to hold other codebases to — meaning any AI kit generated for Knowa itself should visibly practice what `commonPrompt()` preaches: no invented files/commands, explicit adoption steps for real gaps (dependency scanning, `SECURITY.md`), and package-aware guidance if/when Knowa's own repo becomes a workspace.
