---
description: Apply the release skill to ship a new Meridian version.
argument-hint: [note on the release scope, optional]
---

Use the `release` skill — @.claude/skills/release/SKILL.md — and follow it
end to end to turn pending changesets into a CHANGELOG.md entry and a
version-matched git tag.

`$ARGUMENTS` is an optional note on the release's scope. Empty lets the skill
work from the pending changesets alone.
