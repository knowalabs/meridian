---
'@sonalsithara/devpilot': minor
---

New `claude-code` provider: if Claude Code is installed and signed in, DevPilot uses it automatically — `generate` and `ask` work with a Claude Pro/Max subscription and no API key at all (prompts are piped through `claude -p`). The router treats it as zero marginal cost; the model defaults to `sonnet` and can be changed via `router.models.claude-code`. Also adds `DEVPILOT_DISABLE_PROVIDERS` to opt out of specific providers.
