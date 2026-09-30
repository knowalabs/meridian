# @knowalabs/meridian

## 0.2.0

### Minor Changes

- 60a3353: New `meridian agent "<task>"` hands a task to the agent CLI you already use — Claude Code, Codex or Gemini CLI — and then checks the result itself instead of taking the agent's word for it. It compares the working tree before and after the run (commits included), runs the project's own verification chain (one lint, typecheck, build and test script each — the same chain the generated kit documents), and sends a failure back to the same agent session to fix, up to `--max-repairs` times (default 2).

  `--mode plan|edit|auto` maps onto each CLI's own permission flags: `plan` is read-only, `edit` allows file edits plus the commands your kit's `.claude/settings.json` allows, and `auto` allows whatever the agent's own sandbox does. No mode ever passes an agent's permission-bypass flag. Sessions are recorded under `~/.meridian/sessions/`, never in the project, and `--resume` continues the last one on the same agent session. `--json` streams every event as one JSON line. Defaults can be set under a new `harness` block in the config (`mode`, `maxRepairs`, `verify`).

  `meridian doctor` reports each installed agent CLI's version against what `meridian agent` relies on, and flags one too old to drive.

  On Windows, npm-installed CLIs (`codex`, `gemini`, and `npm` itself) are now launched through the script their `.cmd` shim wraps. Node refuses to spawn a `.cmd` without a shell, so these previously failed to start.

- 0b6cbad: Lessons: a mistake one agent makes becomes a rule every agent follows. When `meridian agent` has to send a failing change back for repair and the repair passes your checks, it asks that same agent session — read-only — for the one rule that would have prevented the failure. You review it (`[y/N]` on a terminal, defaulting to No, or later with `meridian lessons`); once accepted it goes into a new `.meridian/lessons.md` and from there into `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor's and Copilot's instruction files, so the next agent — from any vendor — starts out knowing it.

  A lesson is AI-written text that reaches every agent's instructions, so nothing is written without approval, and every line is validated whenever it is read or written: one plain sentence of at most 200 characters, no links, markup, HTML or `@` file references, no invisible characters or override phrasing, nothing that skips or weakens a check, and only scripts and paths that exist in the project. A project keeps at most 25. `meridian lessons` lists them, and `accept`, `reject` and `remove` manage them; `meridian sync` keeps the instruction files in step with `.meridian/lessons.md`, including hand edits. Learning is on by default and costs one extra agent turn only after a repaired failure; turn it off with `--no-learn` or `harness.learn: false`. Lessons need a Meridian kit — `meridian generate rules --no-ai` makes one.

  `meridian agent --mode plan` is now read-only even when the kit's `.claude/settings.json` allows commands: Claude Code applied those allow rules in its default mode, so a kit-allowed `npm run format` could rewrite files in a read-only session. `meridian sync` no longer writes under `--dry-run`, no longer creates instruction files for tools the project does not use, and no longer lists files it re-rendered itself as hand-edited. Instruction files are never written, and `.meridian/rules.md` never read, through a symlink that leads outside the project.

### Patch Changes

- 541a944: `meridian generate` no longer sends a file that links outside the project to the AI provider. Key files such as `README.md`, sampled source files, files the reviewer asks to read, and existing kit files were all read through symlinks, so a repository with `README.md` linked to `~/.ssh/id_rsa` would have put the key in a prompt. Every read now resolves the real path and skips anything outside the project; links that stay inside it still work.

  A provider that sends response headers and then stops no longer hangs `ask`, `generate` or `sync` forever. The 60s timeout used to end when the headers arrived; it now covers the body too, and a streamed answer may go at most 60s between chunks — a long answer that keeps arriving is never cut off.

  `meridian doctor` keeps running when the key vault cannot be decrypted. It used to stop with the vault error — in the one command meant to diagnose it — and now reports the vault as unreadable, marks the providers that need a key as blocked by it, and suggests `meridian keys repair`.

  The generated `.claude/settings.json` no longer contains `Write(docs/**)`, `Write(README.md)` or `Write(.meridian/**)`. Claude Code never consults a path rule for `Write` and warns about each one at startup; the `Edit(...)` rules already cover every tool that writes a file. Existing kits keep their old rules until they are refreshed.

  In the interactive menu, a `--model` given to one command no longer stays in force for the commands that follow it.

## 0.1.2

### Patch Changes

- 3bbb891: `meridian generate` and `meridian sync` now refresh the kit in place instead of writing a second copy of it. A kind's prompt carries the files already under the paths it owns: a file the run may overwrite is refreshed under its own path, a file it may not (hand-edited, or no `--force`) is kept, counted toward the kind's required set, and never asked for again — so a re-run on a kit that already has a `meridian-code-reviewer.md` updates that file rather than adding a `code-reviewer.md` beside it, and an answer that adds nothing is accepted rather than retried. A tracked file the refreshed kit no longer produces is reported as superseded and dropped from the manifest; it is left on disk, and deleting it no longer fails `meridian sync --check`.
- e0ef2ce: `meridian sync` no longer mistakes a formatter pass for a hand edit when a generated file holds a table or JSON. The manifest signature that lets sync tell edits from cosmetic rewrites now also ignores table-separator width and all whitespace, so Prettier padding `| --- |` out to the column or spacing a JSON colon no longer freezes the file out of every future refresh. Signatures are written as `sig2:`; a manifest holding `sig1:` signatures keeps working exactly as before until its next run re-records it.

## 0.1.1

### Patch Changes

- The README now opens with a diagram of what `meridian generate` actually reads and writes: a codebase in, the five instruction files and the rest of the kit out, every path real. The inputs name one manifest per ecosystem — `Cargo.toml`, `go.mod`, `package.json`, `pyproject.toml` — because a Node-only input list misreports a tool whose analyzer reads sixteen manifests across eleven language ecosystems.

  The same misreading was in the prose: "Works on … (Node.js ≥ 18)" reads as a constraint on your project rather than on the CLI that scans it. It now says so plainly, and names the stacks that are supported.

  Everything the README documented it still documents — the commands table, `doctor`, `--estimate`, the kit, `sync`, model selection, security and releasing — reorganised behind a quickstart and collapsible sections rather than a single wall of prose. Two dead links to a long-deleted `Meridian_Docs/` are replaced by an index of the six docs that exist.

  This release exists because npm renders the README captured at publish time: 0.1.0 will show the old one forever.

- `bin.meridian` is `dist/index.js` rather than `./dist/index.js`. npm rewrote it during the 0.1.0 publish and warned it had done so, which left the published metadata disagreeing with the manifest in the repository.

## 0.1.0

First public release. Meridian is a CLI that makes _other_ codebases AI-assistant-ready in one command — it reads a project, then writes the rules, subagents, skills, slash commands, prompts and documentation that AI coding tools need in order to be useful in it.

### The kit

`meridian generate` reviews the codebase with an AI provider before writing anything, and grounds every generated file in that review rather than in a template. It produces:

- **Canonical rules** in `.meridian/rules.md`, mirrored to `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/meridian.mdc` and `.github/copilot-instructions.md` — one source, every tool.
- **Subagents, skills, slash commands and prompts** under `.claude/`, each with an enforced structure: least-privilege `tools:` frontmatter, a scope, a method, a checklist in the project's own failure terms, and an output template. A workflow lives in exactly one place — skills are model-invoked, commands are user-invoked, and a command that duplicates a skill is generated as a handoff to it instead.
- **A `docs/` suite** — architecture, conventions, engineer workflow, plus whichever specialized docs the stack actually warrants. Skipping an inapplicable doc is correct; generic filler is treated as a failure.
- **A permissions harness** (`.claude/settings.json`) derived from the project's real verification commands, with deny rules for `.env` and key files.

Generated content is validated against the project before it is kept: a response naming a script the project does not have, or a path that resolves nowhere, is rejected and re-asked with the findings in hand. Anything that survives the retry is reported rather than passed off as fact, and `isAllowedPath` blocks any AI-suggested path that tries to escape the project directory.

`--rigor light|standard|strict` sets how demanding the generated working agreement is, because a throwaway prototype and a payments backend do not want the same one. The level is recorded in the manifest and read back on refresh, so a kit is never silently re-rigged. `--estimate` reports what a run will cost before it spends anything, and every run reports the kit's standing per-request footprint.

### Keeping it current

`meridian sync` diffs the codebase against the manifest recorded at generation time, regenerates deleted files, refreshes stale ones, and always preserves anything hand-edited. Comparison ignores cosmetic churn, so running a formatter over the kit does not freeze it. `meridian sync --check` reports without writing and exits non-zero when the kit has drifted — a CI gate needing no AI provider, no API keys and no configuration.

### Providers

Twelve providers behind one router, chosen on cost, speed and quality: Anthropic, OpenAI, Google Gemini, Groq, DeepSeek, Mistral, xAI and Ollama by API key or local daemon, plus Claude Code, Codex CLI and Gemini CLI, which need no API key at all and run on a subscription you already have. Requests time out, retry 429s and 5xx with backoff, and map failures to actionable errors. A run that dies partway keeps every file it completed and writes nothing for the kinds that failed, so re-running continues where it left off.

### The rest

`meridian doctor` checks environment, installed AI tools, configured providers, key vault health and the project kit in one read-only pass, ending with an ordered list of what to fix. `meridian install` sets up the AI tools themselves; `meridian mcp` searches and installs MCP servers; `meridian ask` routes a one-off question to the best available provider. API keys are stored in the OS-native vault — Keychain on macOS, libsecret on Linux, DPAPI-protected on Windows — and never passed as command-line arguments.

Runs on Node 18+, on macOS, Linux and Windows.
