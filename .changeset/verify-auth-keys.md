---
'@sonalsithara/devpilot': patch
---

`devpilot auth` now validates the key against the provider before storing it: a cheap authenticated request (no tokens spent) runs first — a rejected key (401/403, or Google's API_KEY_INVALID) is refused with a clear message and never touches the vault, while an unreachable provider stores the key with a warning instead of blocking you offline. Skip the check with `--no-verify`.
