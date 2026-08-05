# Security

How `@sonalsithara/knowa` stores secrets, why AI-suggested file paths are never trusted directly, and which code paths in this repo demand extra care. Read this before touching `src/core/vault.ts`, `src/generate/artifacts.ts`'s `isAllowedPath`, or the harness config Knowa generates for _other_ projects. Not covered: security advice for a target project being scanned — that's whatever `knowa generate` writes into _that_ project's own `docs/security.md`, not this one.

## Secret storage

`src/core/vault.ts`'s `Vault` interface (`set`/`get`/`delete`/`list`) has one implementation per platform, chosen by `openVault()`:

| Backend           | Platform                                                  | Mechanism                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KeychainVault`   | macOS                                                     | Shells out to `security`; `set()` prefers `security -i` (commands over stdin) so the secret never appears in the process argument list, falling back to argv only if stdin fails. |
| `SecretToolVault` | Linux                                                     | Shells out to `secret-tool` (libsecret); `set()` always pipes the secret over stdin, never argv.                                                                                  |
| `FileVault`       | fallback (any platform, or forced via `KNOWA_VAULT=file`) | AES-256-GCM encrypted blob at `<knowaHome>/keys/vault.enc`; the 256-bit master key lives separately at `<knowaHome>/keys/.master`, written with `mode: 0o600`.                    |

Neither `security` nor `secret-tool` can reliably enumerate stored items, so a non-secret index of account _names only_ (never values) is kept at `<knowaHome>/keys/index.json`, written via `indexAdd`/`indexRemove`/`indexWrite` — never add secret material to this file.

On Windows, `FileVault`'s master key is wrapped with `DpapiProtector`, which shells out to PowerShell with the key base64-encoded over **stdin**, never as a command-line argument — do not change this to pass secrets via PowerShell argv. `DpapiProtector.unprotect()` deliberately keeps a legacy plain-hex fallback (`PlainProtector`) for keys stored before the `dpapi:` prefix existed; do not delete it, it would break existing users' stored keys. Where DPAPI/`secret-tool` are unavailable, `FileVault` falls back to `PlainProtector` (plain hex, protected only by the `0o600` file mode) and `openVault()` logs a one-time warning.

`repairVault()` (`src/core/vault.ts`) backs up (`backupFile`) and removes `vault.enc`, `.master` and `index.json` so a corrupted vault can be reinitialized via `knowa keys repair` — it never silently discards without a backup first.

## AI-output path validation

`isAllowedPath(file, allowed)` in `src/generate/artifacts.ts` is the **only** guard between an AI-suggested (or fallback-suggested) file path and a real write. It rejects:

- absolute paths (`path.isAbsolute`) and Windows drive letters (`/^[a-zA-Z]:[\\/]/`);
- `..` traversal, after `path.posix.normalize`;
- anything outside the requesting `ArtifactKind`'s own `allowedPaths` prefix list.

Every new `ArtifactKind` (`src/generate/artifacts.ts`) must route its writes through this check — never construct a write path any other way. `tests/generate.test.ts`'s `describe('isAllowedPath')` block is the place to add new cases, not an ad hoc script.

## Generated harness safety (what Knowa writes for other projects)

The `harness` artifact kind (`src/generate/artifacts.ts`) writes `.claude/settings.json` for the _target_ project with a permission allowlist derived only from that project's real verification scripts, plus deny rules for `.env` and key files. Its AI prompt hard-forbids allowlisting anything destructive or outward-facing (push, publish, deploy, `rm`, `sudo`, `curl`, package installs).

## Destructive workflow steps in generated output

Every artifact kind's prompt (`commonPrompt` in `src/generate/artifacts.ts`) requires that any generated workflow step which is destructive or hard to reverse — committing, pushing, tagging, publishing, deleting, migrating — shows exactly what it is about to do and waits for explicit user approval, with suspected secrets as a hard stop and no "continue anyway" path; amend and force-push are never generated.

## This repo's own publish gating

`.github/workflows/ci.yml`'s `publish` job is gated on a tag-vs-`package.json`-version check and only triggers on `refs/tags/v*` — this is the only thing preventing an accidental `npm publish`. Do not modify it without explicit confirmation, and never run `npm publish` or push a `v*` tag from an assistant session.

## Related

[architecture.md](architecture.md)'s invariants section for the enforcement summary, [engineering-standards.md](engineering-standards.md) for where the repo's security posture stands against an enterprise bar, [conventions.md](conventions.md) for the general secrets/error-handling conventions these mechanisms follow.
