# @sonalsithara/devpilot

## 0.19.0

### Minor Changes

- The reading pass can now ask for the files it is missing, and the kit is written from one standard instead of six.

  Four things decided how good a generated kit was, and all four were leaving quality on the table.

  **The reviewer could not ask for anything.** The digest is a fixed budget spent on files chosen by heuristic, so the one file that would settle a question about a project simply might not be in it — and the review pass, which grounds every artifact generated afterwards, had to guess. It can now ask: it may respond with a `<<<REQUEST>>>` block naming up to 12 paths, twice, and `devpilot generate` serves them under the same rules the digest itself obeys — inside the project, not ignored, not binary, capped per round. Deliberately a text protocol rather than tool-calling, so the keyless CLIs (Claude Code, Codex, Gemini CLI) speak it as fluently as the hosted APIs. The files it asked for are shown to the artifact kinds too, not just the reviewer, and they are recorded in the review cache so a cache hit re-serves them from disk without an AI call.

  **The retry was blind.** A response that invented a script, pointed at a dead path or came back incomplete was rejected — and then re-asked with the identical prompt, even though the validator knew exactly what was wrong. The retry now carries the findings in the project's own terms ("this project has no `deploy` script"), asks for the complete set of files again, and states the rule the second attempt must hold to: name nothing the digest cannot back up, and write an unadopted practice as an adoption step rather than a fact.

  **Nothing knew what the project had actually been working on.** Static analysis answers what is in a repository; only the history answers what is live. The digest now carries a `## Recent activity` section — commits and contributors in the last 180 days, the most-changed files, the areas the work is happening in — and, more importantly, ranks the source it excerpts by churn rather than by file size. A settled 2,000-line module no longer crowds out the file the team has touched fifteen times this quarter, and the review's "Trajectory" section finally has evidence behind it instead of inference. Projects without git, or without commits, are unaffected: the signal is simply absent.

  **Every kind invented its own standard.** Only `commands` built on another kind's output; `agents`, `skills`, `docs` and `prompts` each derived the project's rules independently from the digest, which is how a kit ends up with docs describing one convention and agents enforcing another. They now depend on `rules`, receive the generated `.devpilot/rules.md` in their prompt, and are told to cite it rather than restate it. `commands` gets the rules as well — and still only the skill index, never the skill bodies, so a command keeps delegating to a workflow instead of quietly growing a second copy of it.

  Also fixed: `ignoresPath` in `src/scan/ignore.ts`, so a whole path is tested against the ignore rules of every directory above it. `IgnoreMatcher.ignores` answers for one entry at a time, which is right for a walk that never descends into `node_modules` — but the git history and a file an AI asked to read arrive with no walk behind them, and `node_modules/dep/index.js` would have been served on request.

## 0.18.0

### Minor Changes

- Every generated kit now opens with a working agreement no provider can water down.

  A kit is only worth what an assistant actually does with it, and three failures kept surviving generation: documentation rewritten as an unannounced side effect of a code change, new code placed wherever the model felt like putting it, and implementation starting before the kit was read at all. The prompts asked for good rules; nothing guaranteed the rules covered these at all, and an AI response that omitted them was accepted as complete.

  `.devpilot/rules.md` now leads with a fixed `## Working agreement` section in five numbered clauses — read before you write, follow the architecture, never touch documentation silently, improve old code without changing what it does, report a bug before you fix it. It is not prompted for: `ArtifactKind` gained a `finalize` pass, run over AI and static output alike, so the section is present whether the file came from a provider or the offline template. It is idempotent, so a re-run never stacks it and anything below it survives. The rules prompt is told the section is appended and must not restate it — its job is to make it enforceable with real paths: which module owns which concern, which files to read before touching each area, which of this project's documentation is generated.

  The obligations reach the rest of the kit too. The shared artifact prompt now requires every generated agent, skill, command and prompt that can change files to read first, stay inside the owning module, and treat a documentation edit as deliberate and named rather than incidental. And the generated `.claude/settings.json` carries the mechanical half: `permissions.ask` rules for writes to `docs/`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and `.devpilot/`, so a documentation change surfaces as a prompt instead of appearing in a diff after the fact.

- Old code is modernized instead of imitated, and a defect is reported before it is fixed.

  Generating a kit into an aging codebase produced the wrong instruction: "match the surrounding code" reads as "keep writing it the way it is already written". A weak codebase became its own standard, and the kit entrenched what it should have been raising.

  The shared prompt now states the rule directly — the codebase is the subject, not the standard. Where the scan shows unvalidated boundaries, swallowed errors, duplicated logic, dead code or inline configuration, the generator must name the target pattern, cite the file that sits below it, and mark the existing code as legacy to migrate rather than precedent to copy. `.devpilot/rules.md` gains a `## Legacy code` section for exactly that, and the working agreement resolves the tension explicitly: consistency means consistency with the standard, not with the defect, and the local habit you chose not to copy gets named in your summary.

  Improving that code is now a first-class workflow with a hard boundary around it. `refactor` becomes a required skill — previously only illustrative, even though the generated `new-feature` and `fix-bug` skills already pointed at it, so an AI kit could ship a dangling reference. It covers pinning current behavior before touching anything (characterization tests first where there is no coverage), one transformation at a time with the verification chain between steps, optimizing only with a measurement or complexity argument you can state, and deleting what the refactor replaced.

  New required subagent `.claude/agents/code-modernizer.md` does the work under those constraints: it asks for a concrete scope when the request is vague, baselines the verification chain before starting, reverts a step that turns it red, and holds the public interface, outputs, side effects and failure modes identical. It gets `Edit` but not `Write`. Its single worst failure mode is stated as such — a defect it finds is reported first with `file:line`, impact and the smallest fix, then fixed only after approval, as its own change with a regression test. Its output template has a dedicated "Defects found (NOT fixed)" section, and both the AI prompt and the static fallback produce it, so an offline kit holds the same bar.

## 0.17.0

### Minor Changes

- `devpilot generate` now asks which model version to use, once per provider, and remembers the answer.

  Every provider had exactly one model — the default compiled into its `ProviderSpec`. `router.models.<id>` in `~/.devpilot/config.json` could override it, but nothing surfaced that, no command wrote it, and there was no way to discover what a provider would even accept. Choosing a model meant knowing the exact id string and hand-editing JSON.

  The first `generate` against a provider now shows a picker of that provider's model versions, each with a line on what it is for, and saves the choice under `router.models.<id>` — so later runs skip the prompt, exactly as a saved `router.prefer` already skips the provider prompt. Scripts, pipes, `--json`, and an explicit `--model` never see it.

  This is not Claude-specific: catalogues ship for Anthropic, Claude Code, OpenAI, Google Gemini, DeepSeek, and Mistral, and the picker works for any of the twelve providers. Two deliberate escapes keep a shipped list from becoming a cage — the last entry always accepts a model id typed in full, so a model released after DevPilot is never out of reach, and the model already in play is always listed first, so a choice made before the catalogue existed stays selectable. Ollama is the one provider with no shipped list at all: local models are whatever you pulled, so its options come from `ollama list` at the prompt, falling back to the configured model if the daemon is not answering.

  `devpilot router --model <provider> <model>` sets the choice later; omitting the model restores the provider's default.

- Skills and slash commands stop generating the same workflow twice, and the kit now sets an error-handling and documentation standard.

  **One workflow, one file.** `generate` produced every artifact kind as an independent AI call seeing only the digest, so the `skills` and `commands` prompts — both asked for "this project's real workflows" — kept arriving at the same answers. A generated kit routinely shipped `.claude/skills/verify/SKILL.md` beside a `.claude/commands/verify.md` that restated it, and the two drifted the moment either was edited. An artifact kind can now declare `dependsOn`, and the pipeline runs kinds in dependency waves instead of one flat pool: `commands` waits for `skills` and receives what it wrote. Each skill now gets a same-named slash command that is a four-line handoff to its `SKILL.md`, and the remaining commands cover only one-shot session actions no skill owns — running a script, the verification chain, a read-only diff review, and cleaning up the current session's changes. Generating `commands` alone still works: with no skills pass in the run, the kit already on disk supplies the delegation targets.

  The session-scoped cleanup command is now `/cleanup`, freeing `/refactor` to delegate to the `refactor` skill. Both surfaces stay — skills are model-invoked, commands are user-invoked — but a workflow lives in exactly one of them.

  **Two more standards every generated kit sets.** `handle-errors` encodes how a project fails and what it exposes: its real error type and where it is constructed versus caught, boundary validation, what an actionable message must carry, what must never escape (secrets, tokens, raw stack traces, upstream bodies), and the additive-versus-breaking rule for its public surface. `document` encodes the discipline that keeps user-visible behavior from shipping undocumented — README versus `docs/`, when a changelog entry is required in the repository's real format, and the check for documentation left describing the behavior a change replaced. Both are required of AI responses alongside `commit`, and both are produced by the static fallback, so a kit generated offline holds the same bar.

## 0.16.0

### Minor Changes

- 6271060: The kit now survives your formatter, and its claims are checked against the project.

  **`devpilot sync` no longer mistakes formatting for a hand edit.** The manifest recorded a sha256 of each generated file's raw bytes at write time. Any project with a formatter rewrites the kit's markdown immediately afterwards — Prettier alone changes emphasis markers, list bullets, table padding and blank lines — so the very first `npm run format` after a `generate` made every file read as user-edited. Since `sync` preserves edited files, the kit silently froze: nothing was ever refreshed again. Manifests now record a content signature that ignores exactly those cosmetic degrees of freedom, so a formatter pass leaves the kit clean while a changed word still registers as an edit. Manifests written by earlier versions keep working — their raw hashes are compared the old way until the next `generate` re-records them.

  **Generated content is now validated against the project, not just the path allowlist.** `isAllowedPath` governs where a response may write; nothing governed what it said. Every artifact prompt forbids inventing scripts and files, but that was an honor system, and a kit that confidently tells an assistant to run a script the project does not have is worse than no kit at all. `generateKind` now checks each response for:

  - scripts that do not exist (`npm run typecheck` in a project with no `typecheck` script)
  - path references that resolve nowhere — after reading them the way a reader would, so import specifiers, `src/`-relative shorthand, out-of-project paths and adoption steps that propose a file are not false alarms
  - malformed artifact headers: an agent missing `model`/`tools`, a model that is not `haiku`/`sonnet`/`opus`, a tool name Claude Code does not have, a command with no `description`, or one reading `$ARGUMENTS` without an `argument-hint`

  Blocking problems make a response count as incomplete, so the existing single retry applies. Anything that survives the retry is kept — a missing file helps nobody — and reported at the end of the run instead of being passed off as fact.

## 0.15.0

### Minor Changes

- Generated artifacts now follow a real contract instead of being free-form markdown.

  The kit read well but was structurally thin: a subagent was a role paragraph and a numbered list, a skill was five steps, a slash command was one sentence. Every kind now has an explicit shape, enforced in both the AI prompt and the static fallback.

  - **Subagents** get `model:` and `tools:` frontmatter — least privilege, so a reviewing agent is read-only by omission — plus `## Scope`, `## Context` (as `@`-references to the rest of the kit), `## Method`, `## Checklist` grouped by the areas the project actually has, a `## Severity` ladder defined in the project's own failure terms for review agents, a read-only `## Commands` block, a literal `## Output` template, and `## Forbidden`. Every finding must carry severity, `file:line`, the concrete failure, why it matters here, and the smallest fix — no claim without evidence behind it. The static set gains a `debugger` agent, and the AI is asked for 4–6 agents at 60–140 lines each.
  - **Skills** are now `When to use` (including which sibling skill covers the neighbouring case) / `Before you start` / `Steps` / `Verification` / `Done when` (a checkbox list) / `Never`.
  - **Slash commands** declare `argument-hint` and `allowed-tools` where they apply, state what they do with empty `$ARGUMENTS`, and use `Context` / `Task` / `Report` / `Constraints`.
  - **Prompts** are self-contained and paste-ready: `When to use` / `Context` (project facts stated inline, not links) / `Task` / `Output`, ending in a fenced placeholder block. Adds a `write-tests` prompt.
  - **Docs** must cite the file that proves each claim, open with what they cover, close with a `Related` list, and prefer tables for uniform content. The static suite gains `engineering-standards.md`, which states the bar, where the repo stands today, and each unmet standard as an explicit adoption step.

  The shared prompt now also tells every kind to ground claims in evidence and to cross-reference the rest of the kit by path rather than restating it.

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
