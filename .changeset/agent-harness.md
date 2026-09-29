---
'@knowalabs/meridian': minor
---

New `meridian agent "<task>"` hands a task to the agent CLI you already use — Claude Code, Codex or Gemini CLI — and then checks the result itself instead of taking the agent's word for it. It compares the working tree before and after the run (commits included), runs the project's own verification chain (one lint, typecheck, build and test script each — the same chain the generated kit documents), and sends a failure back to the same agent session to fix, up to `--max-repairs` times (default 2).

`--mode plan|edit|auto` maps onto each CLI's own permission flags: `plan` is read-only, `edit` allows file edits plus the commands your kit's `.claude/settings.json` allows, and `auto` allows whatever the agent's own sandbox does. No mode ever passes an agent's permission-bypass flag. Sessions are recorded under `~/.meridian/sessions/`, never in the project, and `--resume` continues the last one on the same agent session. `--json` streams every event as one JSON line. Defaults can be set under a new `harness` block in the config (`mode`, `maxRepairs`, `verify`).

`meridian doctor` reports each installed agent CLI's version against what `meridian agent` relies on, and flags one too old to drive.

On Windows, npm-installed CLIs (`codex`, `gemini`, and `npm` itself) are now launched through the script their `.cmd` shim wraps. Node refuses to spawn a `.cmd` without a shell, so these previously failed to start.
