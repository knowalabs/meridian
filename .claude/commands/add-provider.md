---
description: Apply the add-provider skill to wire a new AI provider into the router.
argument-hint: [provider id, and API-key or keyless-CLI]
---

Use the `add-provider` skill — @.claude/skills/add-provider/SKILL.md — and
follow it end to end to wire the provider into `src/providers/router.ts` so
`generate`/`ask`/`sync` can route to it.

`$ARGUMENTS` names the provider to add. Empty means ask which provider and
whether it is a hosted API or a keyless CLI.
