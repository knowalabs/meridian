---
'@sonalsithara/knowa': minor
---

DevPilot is now Knowa. Every name the product exposes changed with it.

The package is `@sonalsithara/knowa`, the binary is `knowa`, the global home is `~/.knowa` (`%APPDATA%\knowa` on Windows), the project kit is written to `.knowa/`, and the environment variables are `KNOWA_HOME`, `KNOWA_VAULT` and `KNOWA_DISABLE_PROVIDERS`. The generated Cursor rules file moves from `.cursor/rules/devpilot.mdc` to `.cursor/rules/knowa.mdc`.

**This is a clean break — nothing reads the old locations.** Stored provider keys live under `~/.devpilot`, which the new binary never looks at, so re-run `knowa auth <provider>` once per provider you had configured. A project holding a `.devpilot/` kit is not upgraded in place either: `knowa generate` writes a fresh `.knowa/` alongside it, and the old directory can be deleted once you are happy with the new one. Both were judged cheaper than carrying dual-path resolution through `src/core/paths.ts` and the vault backends for the lifetime of the product.

Entries below this one describe releases that shipped as DevPilot and are left in their original wording.
