---
'@sonalsithara/devpilot': minor
---

The kit now survives your formatter, and its claims are checked against the project.

**`devpilot sync` no longer mistakes formatting for a hand edit.** The manifest recorded a sha256 of each generated file's raw bytes at write time. Any project with a formatter rewrites the kit's markdown immediately afterwards — Prettier alone changes emphasis markers, list bullets, table padding and blank lines — so the very first `npm run format` after a `generate` made every file read as user-edited. Since `sync` preserves edited files, the kit silently froze: nothing was ever refreshed again. Manifests now record a content signature that ignores exactly those cosmetic degrees of freedom, so a formatter pass leaves the kit clean while a changed word still registers as an edit. Manifests written by earlier versions keep working — their raw hashes are compared the old way until the next `generate` re-records them.

**Generated content is now validated against the project, not just the path allowlist.** `isAllowedPath` governs where a response may write; nothing governed what it said. Every artifact prompt forbids inventing scripts and files, but that was an honor system, and a kit that confidently tells an assistant to run a script the project does not have is worse than no kit at all. `generateKind` now checks each response for:

- scripts that do not exist (`npm run typecheck` in a project with no `typecheck` script)
- path references that resolve nowhere — after reading them the way a reader would, so import specifiers, `src/`-relative shorthand, out-of-project paths and adoption steps that propose a file are not false alarms
- malformed artifact headers: an agent missing `model`/`tools`, a model that is not `haiku`/`sonnet`/`opus`, a tool name Claude Code does not have, a command with no `description`, or one reading `$ARGUMENTS` without an `argument-hint`

Blocking problems make a response count as incomplete, so the existing single retry applies. Anything that survives the retry is kept — a missing file helps nobody — and reported at the end of the run instead of being passed off as fact.
