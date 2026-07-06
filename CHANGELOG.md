# @sonalsithara/devpilot

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
