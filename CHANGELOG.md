# @knowalabs/meridian

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
