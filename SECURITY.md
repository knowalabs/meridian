# Security policy

Meridian stores API keys, runs AI-suggested file writes against your project, and edits the config files of other tools on your machine. Those three things are where a vulnerability here would hurt, so they are what this policy is about.

## Reporting a vulnerability

Report privately through GitHub, not in a public issue:

**[Open a private security advisory](https://github.com/knowalabs/meridian/security/advisories/new)** — Security → Advisories → Report a vulnerability.

Please include the version (`meridian --version`), your OS, and the smallest reproduction you can manage. If it involves a key or a token, redact it; the reproduction matters, the secret does not.

Expect an acknowledgement within 3 working days and an assessment within 7. If a fix is warranted it ships as a patch release, and the advisory is published once users have had a chance to update. You will be credited unless you prefer otherwise.

## Supported versions

Only the latest published release is supported. Meridian is pre-1.0 and moves quickly, so fixes land in a new patch release rather than being backported.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## What is in scope

Anything that lets one of these guarantees break:

- **Stored keys stay in the OS secret store.** Keys go to the macOS Keychain, libsecret on Linux, or a DPAPI-wrapped AES-256-GCM vault on Windows, with a `0600` file vault as the fallback. A path that writes a key in plaintext, leaks one through an error message or log line, or passes one as a command-line argument where another local user could read it, is a vulnerability.
- **Generated files stay inside your project.** Every AI-suggested path is checked by `isAllowedPath` before anything is written. A response that escapes the project directory — absolute paths, `..` traversal, Windows drive letters, symlink tricks — is a vulnerability.
- **Tool configs are edited, not hijacked.** MCP installs write `${VAR}` environment references rather than inlining secrets, and back off rather than overwrite a config they cannot parse. Anything that inlines a secret into a project file, or corrupts a config it should have left alone, is a vulnerability.
- **The kit is data, not instructions we execute.** `meridian generate` sends your code to a provider and writes what comes back. A response that causes command execution, rather than file writes inside the allowlist, is a vulnerability.

Prompt injection reaching a provider through the digest is a known property of the design, not a bug: the codebase is untrusted input to the model. It becomes a vulnerability when it escapes the write allowlist. That boundary is the thing to attack.

## What is not a vulnerability

- A missing tool, an unconfigured provider, or an expired key. `meridian doctor` reports these as normal states and exits 0 by design.
- Anything that requires an attacker who already has your user account on your machine. They can read the keychain themselves.
- The DPAPI plain-hex fallback in `unprotect()`. It exists to read master keys stored before the `dpapi:` prefix; removing it without a migration would lock existing users out of their own keys.

## For contributors

`docs/security.md` covers the vault mechanics, the allowlist and the code paths that need extra care. The short version: never put a secret in `argv`, never bypass `isAllowedPath`, and route permissioned writes through `writeFileAtomic` with an explicit mode.
