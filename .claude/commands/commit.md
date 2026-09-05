---
description: Walk the commit skill before creating any git commit in this repo.
argument-hint: [optional note on what the commit is about]
---

Use the `commit` skill — @.claude/skills/commit/SKILL.md — and follow it end
to end; its staged-diff review, secret scanning and message approval are
authoritative here.

`$ARGUMENTS`, when given, is a note on what the commit covers or should
emphasize. Empty runs the skill against the full staged diff as-is.
