# Architecture — @sonalsithara/knowa

## What this project is

`@sonalsithara/knowa` is a Node.js/TypeScript CLI, invoked as `knowa`, that makes _other_ codebases ("the target project") AI-assistant-ready in one command. It is distributed as a global npm package (`bin: { "knowa": "./dist/index.js" }`) and does four jobs:

1. **Tool management** — detect/install/configure AI coding assistants (Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot) via `knowa doctor` / `install` / `uninstall`.
2. **Secret management** — store provider API keys in the OS-native secret store via `knowa auth` / `keys`.
3. **AI-kit generation** — the flagship feature, `knowa generate`: scan a target codebase, build a digest, have an AI provider (or a static fallback) write a codebase review, then generate rules/subagents/skills/commands/prompts/docs, mirrored into every AI tool's own config format.
4. **AI routing** — `knowa ask` / `router` picks the best-suited provider by cost/speed/quality/context size, supporting both hosted HTTP APIs and keyless local CLIs (Claude Code, Codex CLI, Gemini CLI, Ollama).

Domain vocabulary used throughout the codebase: **provider** (an AI backend, `src/providers/router.ts`), **vault** (secret storage, `src/core/vault.ts`), **digest** (the codebase summary fed to AI, `src/generate/digest.ts`), **artifact kind** (a category of generated file, `src/generate/artifacts.ts`), and **kit** (the full generated output set).

## Layers and modules

- **`src/index.ts`** — process entry point only. Imports `./core/colorflag.js` _first_, before anything else, so `NO_COLOR`/color state is mutated before `picocolors` (used almost everywhere) reads it at load time. Checks the Node major version (≥18 required), installs `uncaughtException`/`unhandledRejection`/`SIGINT` handlers that funnel into `renderError`, then dispatches to `launcher.ts` (bare `knowa` in a TTY) or `cli.ts` (`buildCli().parseAsync`). No command logic lives here.

- **`src/cli.ts`** — builds the Commander (`commander` v12) program: registers every subcommand (`doctor`, `install`/`uninstall`, `auth`, `keys …`, `generate`, `mcp …`, `ask`, `router`, `update`, `login`) and recursively attaches global flags (`--verbose`, `-q/--quiet`, `--json`, `--no-color`) via `addGlobalFlags`. Actions call a local `done(exitCode)` helper that sets `process.exitCode` instead of calling `process.exit()`, so the interactive launcher can chain commands in-process.

- **`src/launcher.ts`** — the interactive TUI shown for bare `knowa` in a TTY (`showBanner`, `menuPrompt`, `runInteractive`, `showWelcome`). Implements a raw-mode, arrow-key + type-to-filter menu over `node:readline`, with free text falling through to run as a raw `knowa` command. Deliberately excluded from `vitest.config.ts` coverage thresholds — exercised by humans/e2e, not unit tests.

- **`src/commands/*.ts`** — one file per command group (`doctor.ts`, `install.ts`, `auth.ts`, `generate.ts`, `mcp.ts`, `ask.ts`, `update.ts`). Thin adapters: parse/validate input, call into `core`/`generate`/`providers`/`scan`, return an exit code. No business logic belongs directly in a Commander `.action()` callback.

- **`src/core/`** — cross-cutting infrastructure, isolated per concern:
  - `colorflag.ts` — pre-processes `--no-color`/`NO_COLOR` before other modules load.
  - `errors.ts` — `CliError`, `renderError`, `EXIT` codes; the single channel for user-facing failures.
  - `logger.ts` — `configureLogger`, `log`.
  - `config.ts` — `loadConfig`/`saveConfig` (e.g. `router.models`).
  - `vault.ts` — multi-backend secret storage. `KeychainVault` (macOS `security`), `SecretToolVault` (Linux `secret-tool`), `DpapiProtector`/`PlainProtector` (Windows DPAPI-wrapped or plain-hex file vault), each implementing common `Vault`/`KeyProtector` interfaces — platform branching is isolated per class, not scattered as inline `if (platform === …)` checks. Also maintains a non-secret `keys/index.json` account-name index under `knowaHome()`, since neither `security` nor `secret-tool` can enumerate stored items.
  - `fsx.ts` — `writeFileAtomic`, `backupFile`; all generated/secret file writes go through here, with `mode: 0o600` for sensitive files.
  - `paths.ts` — `knowaHome`, `ensureHome`.
  - `exec.ts` — `run`/`runAsync`/`which` shell-out helpers, test-seamed via `setRunForTests`.
  - `spinner.ts`, `pkg.ts` (`VERSION`).

- **`src/scan/analyzer.ts`** — static, **read-only** analysis of the target project: `analyzeProject(root): ProjectAnalysis` (languages, frameworks, scripts, dependencies, directory tree) plus renderers `renderContextMarkdown`/`renderArchitectureMarkdown`. Must never write files.

- **`src/generate/`** — the AI-kit pipeline:
  - `digest.ts` (`buildDigest`) — turns a `ProjectAnalysis` plus source excerpts into the prompt-ready "PROJECT DIGEST" text block.
  - `artifacts.ts` — `ARTIFACT_KINDS: ArtifactKind[]` (rules, agents, skills, commands, prompts, docs), each supplying `prompt(digest)`, `fallback(analysis)`, and `allowedPaths`. Also owns the `<<<FILE path>>> …
