---
description: Apply the add-artifact-kind skill to add a new meridian generate output.
argument-hint: [artifact kind name]
---

Use the `add-artifact-kind` skill — @.claude/skills/add-artifact-kind/SKILL.md
— and follow it end to end to wire the kind into the `ArtifactKind` contract
and dependency waves in `src/generate/pipeline.ts`.

`$ARGUMENTS` names the new kind. Empty means ask what kind of file `meridian
generate` should produce.
