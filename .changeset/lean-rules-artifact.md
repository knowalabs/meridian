---
'@sonalsithara/meridian': minor
---

Make the generated `.meridian/rules.md` lean enough to carry on every request.

The rules artifact is loaded into an assistant's context on every turn, but its
prompt asked for a module-by-module architecture catalogue and a "Raising the
bar" standards backlog — both of which the `docs/` suite already generates in
fuller form (`docs/architecture.md`, `docs/engineering-standards.md`,
`docs/tech-debt.md`). Kits therefore shipped the same material twice, paid for
the duplicate on every request, and let the two copies drift.

The rules prompt now states its own per-turn cost, asks for boundaries as
imperatives rather than a reference catalogue, drops the standards backlog in
favour of the docs suite that owns it, adds a consult-on-demand "Further
reading" section, and targets 50–90 lines instead of 60–140. It also asks for a
split verification section — a fast loop while iterating, the full CI-order
chain once the change is done — where the project's full chain is slower or
noisier than a quick check. The static fallback matches.
