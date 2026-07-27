# @sonalsithara/devpilot

## 0.14.0

### Minor Changes

- `devpilot doctor` is now a real health check instead of a tool list.

  It was the first command a new user runs and it only answered one question — which AI tools are installed — while the things that actually block people went unreported. It now covers, in one pass:

  - **Environment** — Node version against the supported minimum, whether the DevPilot home is writable (or can be created), and whether the global config parses.
  - **AI tools** — as before, with install hints.
  - **AI providers** — which ones `generate` and `ask` can use _right now_, the model each would run, and which one the router would pick by default. Unconfigured providers are grouped by what they need (a key, a CLI) instead of repeating the same line a dozen times.
  - **Key vault** — the backend in use, the accounts stored in it, and any entry that cannot be read back (with `devpilot keys repair` as the fix).
  - **Project kit** — whether this project has a kit, when it was generated and by which version, whether it has drifted from the code, which generated files were deleted, and how many were hand-edited and will therefore be preserved. Kits generated before manifests existed are called out as untrackable.

  Every failing check carries the command that resolves it, and the report ends with a short ordered "next steps" list. Output stays read-only and offline, and the exit code stays 0 — a missing tool is a normal state, not a broken machine; scripts should parse `--json` (the report is a single structured document) or use `devpilot sync --check`, which exists to fail a build.

  New `--online` flag: verify every stored API key against its provider with a free, tokenless request, reporting each as accepted, rejected or unreachable. It is the fastest way to find a key that has expired or been revoked.

## 0.13.0

### Minor Changes

- Scan accuracy, run speed, monorepo support and provider reach.

  **The scanner now reads your `.gitignore`.** Project walking moved behind one matcher (`src/scan/ignore.ts`) shared by the analyzer's file walk, the layout tree and the digest's source sampling — previously three separate ignore lists that disagreed. It applies root and nested `.gitignore` files plus `.git/info/exclude`, and adds ecosystem build output gated on the marker that proves the ecosystem is present: `target/` in a Cargo/Maven/Gradle project, `vendor/` in Go/PHP/Ruby, `bin/` and `obj/` in .NET, `Pods/` and `DerivedData/` for iOS, `_build/` and `deps/` for Elixir. Build artifacts no longer inflate the file count, fill the code map, or take up digest budget that belongs to real source — which mostly affected exactly the non-Node ecosystems added in 0.10.

  **Monorepos are analyzed as monorepos.** npm/yarn/pnpm workspaces, Lerna, Cargo workspaces and `go.work` are detected, with Turborepo and Nx recorded as runners. Each package's name, path, own scripts and own dependencies appear in `.devpilot/context.md` and in the digest; digest sampling now spreads across packages instead of letting the largest one crowd out the rest; adding or removing a package registers as kit drift for `devpilot sync`; and every artifact prompt is required to say which package a rule or step applies to and to use that package's own commands.

  **Generation is faster and cheaper.** Artifact kinds are generated concurrently — up to a per-provider limit (4 for hosted APIs, 2 for subscription CLIs, 1 for local Ollama), overridable with `--concurrency` — while writes and reporting stay in kind order. The codebase-review pass is cached in the DevPilot home, keyed by project, provider, model, DevPilot version and digest content, so a `devpilot sync` on an unchanged codebase skips it entirely; `--no-cache` forces a fresh read.

  **`devpilot generate --estimate`** reports the digest size, AI call count, token estimate and a cost range before anything is spent, without making a single AI call. Prices are keyed by model (never by provider) and come from a small built-in table or your own `router.pricing.<model>` config — an unknown model reports no cost rather than a wrong one.

  **Provider calls survive a bad minute.** `post()` now retries 408/425/429 and 5xx responses plus dropped connections, up to three attempts with exponential backoff, honoring `Retry-After`; timeouts and 4xx request errors are still reported immediately. A single 502 no longer costs a whole artifact kind.

  **New providers and `ask` improvements.** Groq, DeepSeek, Mistral and xAI (Grok) join the router via a shared OpenAI-compatible client, each with key verification. `devpilot ask` streams the answer as it arrives on a terminal (Anthropic, OpenAI, Google, Ollama and every OpenAI-compatible provider) and buffers when piped or in `--json`; piped stdin becomes context, so `cat error.log | devpilot ask "what failed?"` works; and `-m/--model` overrides the model for a single run of `ask`, `generate` or `sync`.

  Also: the `devpilot login` stub no longer claims Cloud Sync ships in a version that has already passed.

## 0.12.0

### Minor Changes

- The AI kit is now a living artifact: `devpilot generate` records a manifest (`.devpilot/manifest.json`) holding a post-write fingerprint of the project (languages, frameworks, scripts, conventions, top-level directories, API route files) and a sha256 of every file it wrote — including propagated tool files like `CLAUDE.md`. The new **`devpilot sync`** command diffs that fingerprint against a fresh analysis to detect drift, regenerates deleted files, and refreshes only files whose hash still matches what was generated — anything hand-edited is detected and always preserved. `devpilot sync --check` reports without writing and exits 1 when the kit is stale: a CI gate that needs no AI provider, no API keys and no configuration. Sync appears in the interactive launcher and supports `--dry-run`, `--provider`, `--no-ai` and `--json`.
- New `harness` artifact kind (generated by default): `.claude/settings.json` with a permission allowlist derived from the project's real verification commands (test/lint/build/format plus read-only git) and deny rules for `.env` and key files — fewer permission prompts and safer defaults for every teammate who clones the repo. The AI prompt hard-forbids allowlisting anything destructive or outward-facing (push, publish, deploy, rm, sudo, curl, package installs), and hooks are only ever suggested for clearly safe, digest-visible commands.
- New opt-in `ci` artifact kind (`devpilot generate ci`): writes `.github/workflows/devpilot-sync.yml`, a read-only GitHub Action running `devpilot sync --check` on pull requests. Opt-in kinds are excluded from the default "generate everything" set via the new `ArtifactKind.optIn` flag.
- Launch materials: the README documents the sync lifecycle, and a self-contained static landing page now lives in `site/` with a GitHub Pages deploy workflow (enable Pages → GitHub Actions once to publish it).

## 0.11.0

### Minor Changes

- Generated commit skills are now interactive and approval-gated: the required `.claude/skills/commit/SKILL.md` walks through inspecting the staged diff (stopping when nothing is staged, excluding unstaged changes), a safety scan where any suspected secret/credential is a hard stop with no "continue anyway" path (project-specific red flags like debug output, generated files staged without their sources or leftover TODOs prompt the user instead), proposing the full commit message in the repository's real convention and waiting for approve/edit/cancel, committing only after approval (never amending, never staging unapproved files), and asking before any push — force-pushing is banned. Both the AI prompt and the static (`--no-ai`) fallback follow this flow.
- Every artifact kind's prompt (rules, agents, skills, commands, prompts, docs) now carries a shared safety rule: any generated workflow step that is destructive or hard to reverse — committing, pushing, tagging, publishing, deleting, migrating — must show exactly what it is about to do and wait for explicit user approval, with suspected secrets as a hard stop and amend/force-push never generated. This covers AI-generated release skills and slash commands, not just the commit skill.

## 0.10.0

### Minor Changes

- Future-aware, enterprise-grade generation: before anything is generated, the AI codebase review now measures the project against the professional/enterprise bar for its stack (**Maturity & gaps**) and reads where it is headed from the evidence (**Trajectory** — README goals, CHANGELOG history, roadmap/TODO files, half-built modules). Every artifact prompt then demands enterprise-grade standards for the stack's own ecosystem — error handling, input validation, security, test discipline, dependency hygiene — written for where the project is going, with anything the project lacks marked explicitly as an adoption step, never invented as existing. `rules.md` gains a **Raising the bar** section (the static fallback computes real gaps: missing tests, linter, formatter or CI), and the docs suite can now include `engineering-standards.md` and an evidence-grounded `roadmap.md`.
- The digest now reads future-signal and governance files when present — `CHANGELOG.md`, `ROADMAP.md`, `TODO.md`, `SECURITY.md`, `CODEOWNERS` — plus CI configs beyond GitHub Actions (`.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/config.yml`, `azure-pipelines.yml`) and more manifests (`build.gradle.kts`, `setup.py`, `manage.py`, `Package.swift`, `deno.json`).
- Broader ecosystem coverage: the analyzer now detects Elixir (Mix), Swift Package Manager, Deno, .NET (`.csproj`/`.sln`), Django, Ruby on Rails and Laravel, each with its native build/test/lint/format commands (`mix test`, `swift build`, `deno fmt`, `dotnet test`, `python manage.py test`, …), and records GitLab CI, Jenkins, CircleCI, Azure Pipelines and `CODEOWNERS` as project conventions.
- Project-wide code map: the analyzer now extracts every class, function, interface and type per file — across TypeScript/JavaScript (incl. Vue/Svelte/Astro), Python, Go, Rust, Java/Kotlin/Scala/C#, Swift, Ruby, PHP, Dart, Elixir and C/C++ — and the digest surfaces this outline ahead of file excerpts, so the AI sees the project's core concepts even for files whose contents don't fit the context budget. The codebase review must map the domain model (**Core concepts**) before generating, every artifact prompt is required to cover the load-bearing symbols, and `.devpilot/context.md` now includes the code map so static (`--no-ai`) kits carry the real API surface too.

## 0.9.1

### Patch Changes

- f4db45d: `devpilot auth` now validates the key against the provider before storing it: a cheap authenticated request (no tokens spent) runs first — a rejected key (401/403, or Google's API_KEY_INVALID) is refused with a clear message and never touches the vault, while an unreachable provider stores the key with a warning instead of blocking you offline. Skip the check with `--no-verify`.

## 0.9.0

### Minor Changes

- Professional documentation suite: the `docs` artifact kind now writes a real `docs/` folder instead of `.devpilot/architecture.md` + onboarding notes. Four docs are universal — `README.md` (index), `architecture.md`, `conventions.md`, `engineer-workflow.md` — and beyond those the AI chooses the specialized docs the stack actually warrants, guided by examples (`security.md`, `tech-debt.md`, `BEHAVIOUR_CONTRACT_TEMPLATE.md`, `design-system*.md`, `di-registry.md`, `localization.md`, `navigation.md`, `networking.md`, `shared-utilities.md`) but free to invent domain-specific ones (`data-model.md`, `deployment.md`, `cli-reference.md`, …). Skipping an inapplicable doc is correct; generic filler is treated as a failure. Static (`--no-ai`) fallbacks produce a core suite from analysis. The architecture doc's canonical home moved from `.devpilot/architecture.md` to `docs/architecture.md`; generated rules, agents, skills and prompts now point there.
- Workflow skill suite: `devpilot generate` now produces 4–8 skills under `.claude/skills/`, derived from the project's actual workflows and named in its own vocabulary — guided by examples (`new-feature`, `fix-bug`, `refactor`, `feature-info`, `new-utility`, `commit`, `implement-api`, `new-screen`) but free to generate domain-specific ones (`new-command` for a CLI, `release`, `new-migration`, …) and forbidden from generating skills for workflows the project doesn't have. Static fallbacks write a default catalog with steps derived from the real analysis (test commands, module boundaries, route files); replaces the old `project-conventions`/`add-feature` pair.
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
