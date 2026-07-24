# @sonalsithara/devpilot

## 0.9.0

### Minor Changes

- Professional documentation suite: the `docs` artifact kind now writes a real `docs/` folder instead of `.devpilot/architecture.md` + onboarding notes. Seven core docs are always generated — `README.md` (index), `architecture.md`, `conventions.md`, `engineer-workflow.md`, `security.md`, `tech-debt.md` and `BEHAVIOUR_CONTRACT_TEMPLATE.md` — plus specialized docs only when the codebase shows evidence for them: `design-system*.md` (split into core/feature/input component docs for large component libraries), `di-registry.md`, `localization.md`, `navigation.md`, `networking.md` and `shared-utilities.md`. Every doc must cite the project's real paths, modules and commands; generic filler is treated as a failure. Static (`--no-ai`) fallbacks produce the core suite from analysis. The architecture doc's canonical home moved from `.devpilot/architecture.md` to `docs/architecture.md`; generated rules, agents, skills and prompts now point there.
- First-class support for non-Node projects: the analyzer now derives runnable commands from each ecosystem's own manifests — Makefile targets (which win over defaults), Cargo.toml (`cargo test/clippy/fmt`), go.mod (`go test ./...`, `go vet`), pyproject/requirements (`pytest`, `ruff`, `black`, `mypy`), pubspec (`flutter`/`dart test`), Maven, Gradle, Gemfile (`rspec`, `rubocop`) and composer scripts — so verification checklists, slash commands, workflow docs and engineer-workflow content are real for Rust, Go, Python, Flutter, Java, Ruby and PHP projects instead of empty. The AI digest also excerpts sources for previously skipped languages (C, C++, Objective-C, Haskell, Lua, R, Zig, Erlang) and key manifests (`Makefile`, `CMakeLists.txt`, `requirements.txt`, `mix.exs`).

## 0.8.0

### Minor Changes

- 5a7c5ec: Two more keyless providers: `codex-cli` (ChatGPT subscription via `codex exec`, read-only sandbox, clean answer capture through --output-last-message) and `gemini-cli` (Google account via the Gemini CLI). Together with `claude-code`, any signed-in AI CLI now powers `generate`/`ask` with no API key; the provider picker lists whichever are installed. CLI-backed providers use each tool's own default model unless overridden via `router.models.<id>`.

## 0.7.1

### Patch Changes

- d1603b4: Better generate UX: an interactive provider picker appears when several AI providers are available (Enter accepts the recommended one; scripts and pipes auto-route as before), and generation now shows live progress — which files were read, an animated spinner with elapsed time per phase, and per-kind completion lines like "[2/6] Subagents: 3 files (41s)". The claude-code provider now runs asynchronously so the spinner stays alive during CLI calls.
- e6b110b: Generate runs are now resumable: if the provider fails mid-run (e.g. a Claude subscription's 5-hour usage window runs out), DevPilot keeps every AI-generated file, writes nothing for the failed kinds instead of silently downgrading them to generic templates, detects limit/quota errors and stops early, and exits 1 with guidance. Re-running later continues where it left off; `--provider` finishes immediately with another provider. Empty AI responses get one retry.

## 0.7.0

### Minor Changes

- 8313667: `devpilot generate` is now AI-first: it refuses to run without a configured provider (offline templates require an explicit `--no-ai`), and before generating anything the AI reads the codebase digest and writes a full codebase review — saved to `.devpilot/docs/codebase-review.md` — which grounds every generated file. Language detection now covers Vue, Svelte, Astro, Dart, Elixir, Scala, HTML/CSS and more, and framework detection recognizes Flutter, Angular, Tailwind, Vite, Maven, Gradle, Composer and Bundler projects.
- 86324b0: New `claude-code` provider: if Claude Code is installed and signed in, DevPilot uses it automatically — `generate` and `ask` work with a Claude Pro/Max subscription and no API key at all (prompts are piped through `claude -p`). The router treats it as zero marginal cost; the model defaults to `sonnet` and can be changed via `router.models.claude-code`. Also adds `DEVPILOT_DISABLE_PROVIDERS` to opt out of specific providers.

## 0.6.0

### Minor Changes

- 368498f: One command to make a project AI-ready: `devpilot generate` now reviews the codebase first and produces everything in a single run — scaffold, `context.md`, `architecture.md`, rules (mirrored to every tool), subagents, skills, slash commands, prompts and onboarding docs. The separate `init`, `scan` and `rules` commands are gone; their functionality is folded into `generate`. Generated content is much richer: a deeper codebase digest for AI tailoring, and static fallbacks now derive real module boundaries, verification chains and workflows from the code instead of generic templates.

## 0.5.0

### Minor Changes

- 9e60afe: New `devpilot generate` command: produce the complete AI kit for a project — canonical rules (propagated to every tool), Claude Code subagents, skills, slash commands, reusable prompts and AI onboarding docs — tailored to the codebase by the routed AI provider, with static fallbacks so it also works fully offline. Includes `--dry-run`, `--force`, `--no-ai`, `--provider`, per-kind selection and `--json`. Also upgrades vitest to v3 (v4 requires Node ≥ 20; DevPilot still supports Node 18), fixes the spy typing that broke lint on the Dependabot bumps, and clears the brace-expansion audit advisory.

## 0.4.0

First production-hardened release.

### Features

- Global `--verbose`, `--quiet`, `--json` and `--no-color` flags on every command; machine-readable JSON output for `doctor`, `keys list`, `mcp list/search`, `scan` and `ask`.
- Full Windows support: `%APPDATA%\devpilot` home, winget-based tool installs, DPAPI-protected vault master key, `windows-latest` CI coverage.
- Linux support: libsecret (`secret-tool`) key storage when available, install guidance per tool (never runs sudo for you).
- Per-provider model overrides via `router.models` in `~/.devpilot/config.json`.
- Claude Desktop added as an MCP configuration target where installed.
- `devpilot keys repair` recovers from a corrupted vault (with backups).

### Fixes & hardening

- Provider requests now time out after 60s, retry once on 429, and map 401/403/404 and network failures to actionable errors.
- MCP installs no longer overwrite malformed tool configs (backed up and skipped instead) and write `${VAR}` environment references instead of inlining secret values.
- Failed self-updates and tool updates exit non-zero.
- Corrupt config files are backed up and reported instead of silently reset; all state writes are atomic.
- Top-level error boundary with friendly messages and `--verbose` stack traces; the interactive launcher survives command crashes.
- macOS keychain writes pass secrets via stdin instead of process arguments.

## 0.3.0 and earlier

Initial development: doctor, install, auth/keys vault, init, scan, rules,
MCP marketplace, AI router and the interactive launcher.
