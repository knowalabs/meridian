---
'@sonalsithara/meridian': minor
---

Fix the rules-edit workflow, mirror only to detected tools, and report what a
kit costs per request.

**The documented rules workflow destroyed the edit it asked for.** Every
generated agreement said to edit `.meridian/rules.md` and re-run
`meridian generate rules --force` — but that command regenerates `.meridian/rules.md`
itself, discarding the edit before it ever reached `CLAUDE.md` and the other
mirrors. `meridian sync` preserved the edit but never propagated it, so there was
no supported path from the canonical rules to the tool files at all.

`meridian sync` now detects mirrors that no longer render from a hand-edited
`.meridian/rules.md` and re-renders them from the rules file directly — no AI
call, no regeneration, so the edit survives and reaches every tool. `--check`
reports it and exits non-zero, which is what CI wants. A hand-edit to a mirror
rather than to the canonical file is unaffected: that case is already covered
by "overwritten on the next generate" and must not start failing `--check`.
Comparison uses the manifest's cosmetic-insensitive signature, so a repo that
runs a markdown formatter over its tool files does not read as permanently
stale. The instruction is corrected in all three rigour tiers.

**Rule mirrors now follow the tools that are actually there.** `generate`
wrote all five instruction files into every project regardless — a Claude-only
user got four dead files that drift apart over time. It now mirrors to the
tools detected for the project (installed on the machine, or already carrying
config in the repo), falling back to all five when none is detected so a
container or CI box still produces a complete kit. `--tools claude,cursor` or
`--tools all` overrides detection, and `setToolDetectionForTests` keeps runs
from depending on what the developer happens to have installed.

**`generate` now reports the kit's standing cost.** `--estimate` answered what
a run will charge; nothing answered what the result charges on every request
afterwards, which is the number that decides whether a kit's rigour is worth
carrying. It prints the resident total with a rules/agents/skills/commands
breakdown and a pointer to `--rigor`. Descriptions are counted rather than
whole files, because that is what a tool actually keeps resident.
