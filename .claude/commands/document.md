---
description: Apply the document skill to a user-visible behavior change.
argument-hint: [the flag, command or behavior that changed]
---

Use the `document` skill — @.claude/skills/document/SKILL.md — and follow it
end to end to find where the change must be documented and catch docs left
describing the old behavior.

`$ARGUMENTS` names what changed. Empty runs the skill against the current
diff's user-visible changes.
