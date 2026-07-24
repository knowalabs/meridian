# DevPilot

**One command to set up every AI coding tool on any machine.**

```bash
npm install -g @sonalsithara/devpilot
devpilot generate
```

DevPilot installs, configures and manages AI coding assistants (Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot), keeps your API keys in the OS-native secret store, generates AI-ready project context and rules, and installs MCP servers into every tool at once.

You never hand-write an AI config file again: one command — `devpilot generate` — reviews your codebase and produces the **complete AI kit**: project context and architecture docs, canonical rules mirrored into every tool's format, Claude Code subagents, skills and slash commands, reusable prompts and onboarding docs — tailored to your stack by AI (with rich static fallbacks when no API key is configured).

Works on **macOS, Windows and Linux** (Node.js ≥ 18).

## Interactive mode

Run `devpilot` with no arguments to open the interactive launcher: navigate the menu with **↑/↓** and run with **Enter**, or just start typing — text filters the menu live, and anything that isn't a menu item runs as a raw command (e.g. `install claude`). **Tab** completes the highlighted item into the input line, **Esc** clears it, **q** quits. After each command you land back in the menu.

## Commands

| Command                                   | What it does                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devpilot doctor`                         | Detect installed tools (Git, Node, VS Code, Cursor, Claude Code, Codex, Gemini CLI, Docker)                                                                                    |
| `devpilot install <tool>` \| `all`        | Install and configure supported tools (npm / Homebrew / winget)                                                                                                                |
| `devpilot auth [provider]`                | Store an API key in the secure vault (OpenAI, Anthropic, Google, OpenRouter)                                                                                                   |
| `devpilot keys list/remove/repair`        | Manage stored keys (always masked, never plaintext)                                                                                                                            |
| `devpilot generate [kinds…]`              | Review the codebase, then generate everything: context, architecture, rules (mirrored to every tool), `.claude/agents/`, `.claude/skills/`, `.claude/commands/`, prompts, docs |
| `devpilot mcp search/install/remove/list` | Curated MCP marketplace — one install configures all detected tools (incl. Claude Desktop)                                                                                     |
| `devpilot ask "<prompt>"`                 | AI router: picks the best provider by cost/speed/quality/context size                                                                                                          |
| `devpilot router --prefer/--optimize`     | Configure routing behavior                                                                                                                                                     |
| `devpilot update`                         | Update the CLI and installed tools                                                                                                                                             |
| `devpilot login`                          | Cloud Sync (coming in v0.5)                                                                                                                                                    |

### Global flags

Every command accepts:

- `--json` — machine-readable output (`doctor`, `keys list`, `mcp list/search`, `ask`, `generate`)
- `--quiet` — errors only
- `--verbose` — debug output and stack traces
- `--no-color` — plain output (also honors `NO_COLOR`)

`devpilot ask` prints routing diagnostics to stderr, so `devpilot ask "…" | pbcopy` pipes only the answer:

```bash
devpilot doctor --json | jq '.missing'
devpilot ask "explain this repo" --json | jq -r .answer
```

### The AI kit

`devpilot generate` is AI-first: it builds a deep digest of the codebase — layout, dependencies, scripts, conventions and excerpts of the most informative source files — has your best configured provider **read it and write a codebase review** (saved to `.devpilot/docs/codebase-review.md`), then generates every artifact grounded in that review. It refuses to run without a provider; plain templates are an explicit opt-in via `--no-ai`.

**No API key required if you're signed in to an AI CLI.** DevPilot automatically detects and uses, in this order of quality: [Claude Code](https://claude.com/claude-code) (`claude-code` — your Claude Pro/Max plan, via `claude -p`), Codex CLI (`codex-cli` — your ChatGPT plan, via `codex exec` in read-only sandbox), and Gemini CLI (`gemini-cli` — your Google account). When several are available, `generate` shows a picker; persist a choice with `devpilot router --prefer <id>`. Otherwise add an API key with `devpilot auth`, or install Ollama for a free local model. CLI models default to each tool's own configuration and can be overridden via `router.models.<id>` (note: Antigravity is an IDE without a headless CLI — its Google-account equivalent here is Gemini CLI).

```bash
devpilot generate                    # everything: context, rules, agents, skills, commands, prompts, docs
devpilot generate agents commands    # just those kinds
devpilot generate --dry-run          # preview without writing
devpilot generate --force            # regenerate over existing files
devpilot generate --no-ai            # static templates only (offline)
```

Derived files that mirror the code (`.devpilot/context.md`, `.devpilot/docs/codebase-review.md`) are refreshed on every run; everything you might have hand-edited is never overwritten without `--force`. AI output paths are validated against a per-kind allowlist.

**Runs are resumable.** If the provider fails mid-run — say your Claude subscription's 5-hour usage window runs out — DevPilot keeps every AI-generated file, writes nothing for the failed kinds (no silent downgrade to generic templates), and exits with a note. Re-run `devpilot generate` after the window resets and it continues where it left off, generating only what's missing; or finish immediately with another provider via `--provider`.

### Model selection

The router ships with sensible model defaults per provider and lets you override them without waiting for a release, in `~/.devpilot/config.json`:

```json
{ "router": { "models": { "anthropic": "claude-opus-4-8", "openai": "gpt-5.1" } } }
```

## Security

API keys are stored in the strongest secret store available on your platform, and never written to disk in plaintext:

| Platform | Backend                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------- |
| macOS    | System Keychain (`security`, service `devpilot`) — secrets passed via stdin, not process args           |
| Windows  | AES-256-GCM vault; master key wrapped with **DPAPI** (CurrentUser) and the key directory ACL-restricted |
| Linux    | **libsecret** (`secret-tool`) when available, else the encrypted file vault                             |
| Fallback | AES-256-GCM vault in `~/.devpilot/keys/vault.enc` with a `0600` master-key file                         |

Set `DEVPILOT_VAULT=file` to force the file vault (used by CI). MCP configs get `${VAR}` environment references — your tokens are never inlined into project files. If a vault ever corrupts, `devpilot keys repair` backs it up and reinitializes.

## Architecture

```
CLI (commander) → Core (config, vault, exec, errors) → Plugins (tool lifecycle) → Providers (AI APIs)
```

Every tool plugin implements the same lifecycle: `install() · uninstall() · configure() · validate() · update() · doctor()`.

## Development

```bash
npm install
npm run dev -- doctor   # run from source
npm test                # unit tests (vitest)
npm run test:e2e        # runs the built CLI end-to-end in a sandbox
npm run test:coverage   # unit tests + coverage gates
npm run lint            # type-checked eslint
npm run build           # tsc → dist/
```

CI runs lint, format check, build, unit + e2e tests on ubuntu/macos/windows × Node 18/20/22. Releases are tag-driven with npm provenance.

### Releasing

```bash
npx changeset            # describe your change
npx changeset version    # bump version + update CHANGELOG.md
git commit -am "release" && git tag v<version> && git push --follow-tags
```

The `publish` CI job verifies the tag matches `package.json`, re-runs the tests, and publishes to npm with `--provenance`.

Product documentation lives in [`DevPilot_Docs/`](DevPilot_Docs/); the roadmap is in [`DevPilot_Docs/04-roadmap.md`](DevPilot_Docs/04-roadmap.md). This codebase implements v0.1–v0.4 (doctor, install, auth, init, scan, rules, MCP, updater, AI router); Cloud Sync and Team features need the backend and ship next.
