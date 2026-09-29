---
'@knowalabs/meridian': patch
---

`meridian generate` no longer sends a file that links outside the project to the AI provider. Key files such as `README.md`, sampled source files, files the reviewer asks to read, and existing kit files were all read through symlinks, so a repository with `README.md` linked to `~/.ssh/id_rsa` would have put the key in a prompt. Every read now resolves the real path and skips anything outside the project; links that stay inside it still work.

A provider that sends response headers and then stops no longer hangs `ask`, `generate` or `sync` forever. The 60s timeout used to end when the headers arrived; it now covers the body too, and a streamed answer may go at most 60s between chunks — a long answer that keeps arriving is never cut off.

`meridian doctor` keeps running when the key vault cannot be decrypted. It used to stop with the vault error — in the one command meant to diagnose it — and now reports the vault as unreadable, marks the providers that need a key as blocked by it, and suggests `meridian keys repair`.

The generated `.claude/settings.json` no longer contains `Write(docs/**)`, `Write(README.md)` or `Write(.meridian/**)`. Claude Code never consults a path rule for `Write` and warns about each one at startup; the `Edit(...)` rules already cover every tool that writes a file. Existing kits keep their old rules until they are refreshed.

In the interactive menu, a `--model` given to one command no longer stays in force for the commands that follow it.
