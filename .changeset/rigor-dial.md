---
'@sonalsithara/meridian': minor
---

Add `meridian generate --rigor light|standard|strict`, and shrink the kit's
always-resident footprint.

The generated working agreement trades speed for rigour on purpose, but it was
hardcoded at maximum for every project — a throwaway prototype and a payments
backend got the same 85-line agreement mandating a three-document read before
the first edit, a stop-and-wait round trip on any bug found, characterization
tests before any refactor, and a verification run between every individual
transformation. That is the right trade for some codebases and not others, and
there was no dial.

- `--rigor light` (~23 lines) keeps only the rules whose absence is expensive
  to undo: read before you write, and never edit documentation silently.
- `--rigor standard` (~59 lines, the new default) adds architectural discipline
  and bug reporting, reaches for `docs/architecture.md` when a change crosses a
  boundary rather than as a fixed preamble to every task, and reports found
  defects in the summary instead of stopping mid-task.
- `--rigor strict` (~85 lines) is the previous behaviour, byte-identical.

The level is recorded in `.meridian/manifest.json`, and `meridian sync` reads it back,
so refreshing a kit never silently re-rigs it. Manifests written before this
release have no level and are treated as `standard`.

Separately, the kinds whose descriptions stay resident in an assistant's system
prompt for the whole session now ask for fewer files: agents 5→3, skills 6→4,
commands 4→3, with the prompts' requested counts lowered to match.
