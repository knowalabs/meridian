# DevPilot

**One command to set up every AI coding tool on any machine.**

```bash
npm install -g devpilot
devpilot init
```

DevPilot installs, configures and manages AI coding assistants (Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot), keeps your API keys in the OS keychain, generates AI-ready project context and rules, and installs MCP servers into every tool at once.

## Interactive mode

Run `devpilot` with no arguments to open the interactive launcher: navigate the menu with **↑/↓** and run with **Enter**, or just start typing — text filters the menu live, and anything that isn't a menu item runs as a raw command (e.g. `install claude`). **Tab** completes the highlighted item into the input line, **Esc** clears it, **q** quits. After each command you land back in the menu.

## Commands

| Command | What it does |
| --- | --- |
| `devpilot doctor` | Detect installed tools (Git, Node, VS Code, Cursor, Claude Code, Codex, Gemini CLI, Docker) |
| `devpilot install <tool>` \| `all` | Install and configure supported tools |
| `devpilot auth [provider]` | Store an API key in the secure vault (OpenAI, Anthropic, Google, OpenRouter) |
| `devpilot keys list` / `keys remove <p>` | Manage stored keys (always masked, never plaintext) |
| `devpilot init` | Create the AI-ready scaffold: `.devpilot/`, `CLAUDE.md`, `AGENTS.md`, `README_AI.md` |
| `devpilot scan` | Analyze the project → `.devpilot/context.md` + `architecture.md` (structure, deps, conventions, API surface) |
| `devpilot rules generate` | Render `.devpilot/rules.md` into every tool's format: `CLAUDE.md`, `.cursor/rules/`, `AGENTS.md`, Copilot, `GEMINI.md` |
| `devpilot mcp search/install/remove/list` | Curated MCP marketplace — one install configures all detected tools |
| `devpilot ask "<prompt>"` | AI router: picks the best provider by cost/speed/quality/context size |
| `devpilot router --prefer/--optimize` | Configure routing behavior |
| `devpilot update` | Update the CLI and installed tools |
| `devpilot login` | Cloud Sync (coming in v0.4) |

## Security

- **macOS:** keys are stored in the system Keychain (`security` service `devpilot`).
- **Other platforms** (or `DEVPILOT_VAULT=file`): AES-256-GCM encrypted vault in `~/.devpilot/keys/vault.enc`, with a random 256-bit master key held in a separate `0600` file. Secrets are never written in plaintext.

## Architecture

```
CLI (commander) → Core (config, vault, exec) → Plugins (tool lifecycle) → Providers (AI APIs) → Cloud (v0.4)
```

Every tool plugin implements the same lifecycle: `install() · uninstall() · configure() · validate() · update() · doctor()`.

## Development

```bash
npm install
npm run dev -- doctor   # run from source
npm test                # vitest
npm run lint            # eslint
npm run build           # tsc → dist/
```

Product documentation lives in [`DevPilot_Docs/`](DevPilot_Docs/); the roadmap is in [`DevPilot_Docs/04-roadmap.md`](DevPilot_Docs/04-roadmap.md). This codebase implements v0.1–v0.3 (doctor, install, auth, init, scan, rules, MCP, updater) plus the Phase 4 AI router; Cloud Sync (v0.4) and Team features need the backend and ship next.
