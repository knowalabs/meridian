# CLI reference

Every `meridian` subcommand, its aliases and flags, as registered in `src/cli.ts`. Read this when you need the exact flag name or alias rather than re-deriving it from `--help`. Not covered: what each command does internally — see [architecture.md](architecture.md) for `generate`/`sync`'s pipeline, [provider-matrix.md](provider-matrix.md) for `ask`/`router`'s provider selection.

## Global flags

Registered on every leaf command via `addGlobalFlags` in `src/cli.ts`:

| Flag          | Effect                                                        |
| ------------- | ------------------------------------------------------------- |
| `--verbose`   | Debug output and stack traces.                                |
| `-q, --quiet` | Errors only.                                                  |
| `--json`      | Machine-readable JSON output (where the command supports it). |
| `--no-color`  | Disable colored output (also honors `NO_COLOR`).              |

## Commands

| Command                           | Alias     | Key flags                                                                                                            | What it does                                                                                                                                                       |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meridian doctor`                 | `dr`      | `--online`                                                                                                           | Health check: environment, tools, providers, vault, project kit. Always exits 0.                                                                                   |
| `meridian install [tool]`         | `i`       | —                                                                                                                    | Install and configure a tool; omit `tool` for an interactive picker, or pass `all`.                                                                                |
| `meridian uninstall [tool]`       | —         | —                                                                                                                    | Uninstall a tool managed by Meridian.                                                                                                                              |
| `meridian auth [provider] [key]`  | —         | `--no-verify`                                                                                                        | Store an API key in the vault; verified against the provider unless `--no-verify`.                                                                                 |
| `meridian keys list`              | `keys ls` | —                                                                                                                    | List stored keys (masked).                                                                                                                                         |
| `meridian keys remove <provider>` | `keys rm` | —                                                                                                                    | Delete a stored key.                                                                                                                                               |
| `meridian keys repair`            | —         | —                                                                                                                    | Back up and reinitialize a corrupted vault.                                                                                                                        |
| `meridian generate [kinds...]`    | `gen`     | `-p/--provider`, `-f/--force`, `--dry-run`, `--estimate`, `-m/--model`, `--concurrency <n>`, `--no-cache`, `--no-ai` | Review the codebase and generate the AI kit. Kinds: `rules`, `agents`, `skills`, `commands`, `prompts`, `docs`, `harness` (default: all); opt-in only: `ci`.       |
| `meridian sync`                   | —         | `--check`, `-p/--provider`, `--dry-run`, `--concurrency <n>`, `-m/--model`, `--no-cache`, `--no-ai`                  | Detect drift between the codebase and the generated kit, refresh what's stale. `--check` reports only and exits 1 when stale — no AI or keys needed, built for CI. |
| `meridian mcp search [query]`     | —         | —                                                                                                                    | Search the MCP server registry.                                                                                                                                    |
| `meridian mcp install <id>`       | `mcp i`   | —                                                                                                                    | Install an MCP server into every detected tool.                                                                                                                    |
| `meridian mcp remove <id>`        | `mcp rm`  | —                                                                                                                    | Remove an MCP server from all configs.                                                                                                                             |
| `meridian mcp list`               | `mcp ls`  | —                                                                                                                    | List installed MCP servers.                                                                                                                                        |
| `meridian ask [prompt...]`        | —         | `-p/--provider`, `-m/--model`                                                                                        | Ask AI, routed to the best available provider. Piped stdin becomes context; answer streams on a TTY, buffers when piped or `--json`.                               |
| `meridian router`                 | —         | `--prefer <provider>`, `--optimize <metric>`                                                                         | Configure the AI router's default preference/optimization metric.                                                                                                  |
| `meridian update`                 | —         | `--self`, `--tools`                                                                                                  | Update the Meridian CLI and/or installed tools.                                                                                                                    |
| `meridian login`                  | —         | —                                                                                                                    | Sign in for Cloud Sync — **not implemented yet** (see [roadmap.md](roadmap.md)).                                                                                   |

## Notes on specific commands

- `meridian generate` is AI-first and refuses to run without a provider unless `--no-ai` is passed explicitly (`src/commands/generate.ts`'s `generateCommand`).
- `meridian generate --estimate` makes no AI call — it builds the real digest and reports token/cost estimates only (`estimateCommand` in `src/commands/generate.ts`).
- `meridian doctor` and `meridian sync --check` are both read-only/offline by default and safe to run in CI; `doctor` always exits 0, `sync --check` exits 1 on drift.

## Related

[architecture.md](architecture.md) for how `generate`/`sync` route through the pipeline these flags configure, [provider-matrix.md](provider-matrix.md) for what `-p/--provider` and `-m/--model` actually select among.
