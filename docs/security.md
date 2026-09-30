The security-critical surface of the Meridian CLI itself: the key vault, the boundary that keeps AI-suggested writes inside the target project, and how tool configs get edited. Read this before touching any file `CODEOWNERS` flags, and read `SECURITY.md` at the repo root first for the disclosure process — this doc is the engineering detail behind it.

## What is security-critical, and why

`CODEOWNERS` names exactly four things as requiring explicit sign-off, and `SECURITY.md` explains why:

| Path                        | Why it matters                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/core/vault.ts`         | Owns every API key Meridian stores. A bug here can leak a secret to disk, a log line, or another local user.        |
| `src/generate/artifacts.ts` | Owns `isAllowedPath` — the only thing stopping AI-suggested file writes from escaping the target project directory. |
| `.github/workflows/`        | Governs what `publish` runs and what secrets it has access to (`NODE_AUTH_TOKEN`).                                  |
| `SECURITY.md`               | The disclosure process itself; changing it changes how a real report gets handled.                                  |

## The key vault

`src/core/vault.ts` exposes one `Vault` interface with four backends, chosen by `openVault()`:

- **macOS**: `KeychainVault`, via the `security` CLI — the secret is written through `-i` (stdin) so it never appears in the process argument list; only falls back to argv if stdin mode fails.
- **Linux**: `SecretToolVault`, via `secret-tool`, secret piped over stdin the same way.
- **Windows**: `FileVault` wrapped by `DpapiProtector` — the master key is protected with Windows DPAPI (`CurrentUser` scope) via PowerShell; secrets themselves are AES-256-GCM encrypted with that master key.
- **Fallback** (any platform, or `MERIDIAN_VAULT=file`): `FileVault` with a plain hex-encoded master key, restricted to `0600` — used when no OS-native store is available.

Never bypass `openVault()` to read or write a secret directly via `fs` — every command that needs a key (`src/commands/auth.ts`, `src/commands/ask.ts`, `src/generate/pipeline.ts`) goes through it. `repairVault()` backs up and clears file-vault state for recovery; it is the only sanctioned destructive vault operation, gated behind the explicit `meridian keys repair` subcommand.

## The artifact write boundary

`isAllowedPath` (`src/generate/artifacts.ts`) checks every path an AI response names before anything is written: it rejects absolute paths, Windows drive letters, and `..` escapes, and requires the path to fall under one of the `ArtifactKind`'s declared `allowedPaths`. `SECURITY.md` states this plainly: "Prompt injection reaching a provider through the digest is a known property of the design, not a bug... It becomes a vulnerability when it escapes the write allowlist. That boundary is the thing to attack." Any new `ArtifactKind` or path-handling code must route through this function — never construct a write path independently.

## Reads that reach a provider

Everything `src/generate/digest.ts` and `src/generate/pipeline.ts` read for a prompt — key files, sampled sources, files the reviewer requests, existing kit files — passes `insideProject` (`src/generate/digest.ts`) first, which resolves the real path and rejects anything outside the project. Checking the path as written is not enough: a symlink inside the project can point at a key file anywhere on the machine. New code that puts file contents into a prompt must use the same check.

## The agent harness

`meridian agent` (`src/harness/`) runs an agent CLI, so its boundary is permissions rather than an allowlist:

- **Mode mapping** lives in each driver's `args()` (`src/harness/drivers/*.ts`), tested per mode. No mode may pass a bypass flag (`bypassPermissions`, `--dangerously-*`, `danger-full-access`). Read-only uses each CLI's default mode with nobody to approve anything — not Claude's or Gemini's own `plan` modes, which write outside the project or fall through to unrestricted execution. For Claude it also removes every tool that can change a file (`--disallowedTools`), because a kit's allow rules still load in default mode and `Bash(npm run format)` rewrites files.
- **Verification** (`src/harness/verify.ts`) runs commands split on whitespace, without a shell; `harness.verify` entries containing shell syntax are rejected. A failing command's output goes back to the agent fenced and labelled untrusted.
- **Session records** (`src/harness/session.ts`) are written under `meridianHome()` with `0700`/`0600` modes, never into the project.
- **Lessons** are AI-written text that reaches every tool's instruction file, which makes them a prompt-injection path into every agent. `src/rules/lessons.ts` validates every line on read and on write — one plain line, no markup, HTML, links or `@` file references (Claude Code expands those into the file's contents), no invisible characters, no override phrasing, nothing that weakens a check — and proposals must also name only scripts and paths that exist. Nothing is written without a human accepting the exact text (`meridian lessons accept`, or `[y/N]` defaulting to No); the lesson turn itself runs read-only, and if the agent changes files anyway the change is verified again.

## MCP config writes

MCP server installs (`src/mcp/configure.ts`'s `addServer`/`writeConfig`) write `${VAR}` environment-variable references into a tool's config, never a resolved secret value — confirmed by `tests/mcp.test.ts`'s assertion that a stored `GITHUB_PERSONAL_ACCESS_TOKEN` never appears in the written `.mcp.json`. Writes are defensive against a config file that already exists and is malformed: `addServer` backs up an unparseable config and skips it rather than overwriting it (`tests/mcp.test.ts`'s "never destroys a malformed tool config" case), and refuses to merge into a config whose `mcpServers` field has an unexpected shape.

## What is not in scope

- A missing tool, unconfigured provider, or expired key — `meridian doctor` reports these as normal states by design, not vulnerabilities (`SECURITY.md`).
- Anything requiring an attacker who already controls the local user account — they can already read the OS keychain directly.
- The DPAPI plain-hex fallback path in `unprotect()` — it exists only to read master keys stored before the `dpapi:` prefix existed; removing it without a migration would lock out existing users.

## Related

- [architecture.md](architecture.md) — where the vault, artifact pipeline and MCP writer sit in the module map.
- `SECURITY.md` (repo root) — the vulnerability disclosure process this doc supports.
- `.meridian/rules.md`'s Safety section — the operational rules (never put a secret in argv/logs, never hand-edit a mirror or manifest file) layered on top of this doc.
