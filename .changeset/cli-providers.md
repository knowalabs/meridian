---
'@sonalsithara/devpilot': minor
---

Two more keyless providers: `codex-cli` (ChatGPT subscription via `codex exec`, read-only sandbox, clean answer capture through --output-last-message) and `gemini-cli` (Google account via the Gemini CLI). Together with `claude-code`, any signed-in AI CLI now powers `generate`/`ask` with no API key; the provider picker lists whichever are installed. CLI-backed providers use each tool's own default model unless overridden via `router.models.<id>`.
