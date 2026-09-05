---
'@knowalabs/meridian': patch
---

`meridian generate` and `meridian sync` now refresh the kit in place instead of writing a second copy of it. A kind's prompt carries the files already under the paths it owns: a file the run may overwrite is refreshed under its own path, a file it may not (hand-edited, or no `--force`) is kept, counted toward the kind's required set, and never asked for again — so a re-run on a kit that already has a `meridian-code-reviewer.md` updates that file rather than adding a `code-reviewer.md` beside it, and an answer that adds nothing is accepted rather than retried. A tracked file the refreshed kit no longer produces is reported as superseded and dropped from the manifest; it is left on disk, and deleting it no longer fails `meridian sync --check`.
