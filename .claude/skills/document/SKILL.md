---
name: document
description: Use whenever a change alters user-visible behavior — a flag, a command, a default, an output shape — to decide where it must be documented and to catch docs left describing the old behavior.
---

# Document

## When to use

Use whenever a change alters what a user sees or does: a new/changed CLI flag or command, a changed default, a new output shape, a security-relevant behavior. Not for internal refactors with no user-visible change (use `refactor`, which explicitly forbids doc edits as a side effect).

## Before you start

- @.meridian/rules.md — rule 3: never touch documentation silently.
- README.md — the user-facing surface: quickstart, the commands table, flags.
- @docs/architecture.md, @docs/conventions.md, @docs/engineer-workflow.md — the engineer-facing suite.
- CHANGELOG.md and any pending files under `.changeset/` — this project's real release-notes format.
- SECURITY.md — the one specialized reference doc this project maintains inline.

## Steps

1. Decide the destination by audience, not by convenience: README.md for anything a user of the `meridian` CLI needs (commands, flags, quickstart, `--json` shapes); `docs/architecture.md`/`docs/conventions.md`/`docs/engineer-workflow.md` for anything only a contributor to this codebase needs; SECURITY.md for anything touching the vault, `isAllowedPath`, or MCP secret handling.
2. If the change is user-visible, add a changeset: run `npx changeset` (the project depends on `@changesets/cli`) and write the entry as it will read in CHANGELOG.md — see the `## 0.1.1`/`### Patch Changes` entries there for the real format and tone (specific, names the file/behavior, explains why the release exists). A changeset is required for every user-visible change; not for a docs-only or internal-refactor change.
3. Edit only the section that is now wrong. Do not regenerate or reorganize a doc as a side effect — `.meridian/rules.md` rule 3 forbids it, and README.md's own 0.1.1 changelog entry describes exactly the failure of a stale doc (its Node-version wording once read as a project constraint instead of a CLI-runtime one).
4. Cross-check the specific failure mode: a command's flags or behavior changed in `src/commands/*.ts` or `src/cli.ts` but README.md's commands table, or the relevant `addHelpText('after', …)` block, still describes the old ones. Read both side by side before considering the change done.
5. Announce every doc file touched and what changed, by name, in your summary — never a silent doc edit.

## Verification

- Re-read the edited section against the actual code path it documents (the flag definition in `src/cli.ts`, the command action in `src/commands/*.ts`) and confirm they now agree.
- `npx prettier --check .` — edited markdown still passes formatting.
- If a changeset was added, confirm the file exists under `.changeset/` and its content matches the CHANGELOG.md tone.

## Done when

- [ ] The doc whose audience matches the change (README.md vs. `docs/`) was updated, and only that section.
- [ ] A changeset exists under `.changeset/` for every user-visible change.
- [ ] No doc still describes the pre-change behavior.
- [ ] The summary of work names every doc file touched.

## Never

- Never regenerate or reorganize a doc as a side effect of an unrelated code change.
- Never hand-edit `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/meridian.mdc`, or `.github/copilot-instructions.md` — they are mirrors of `.meridian/rules.md`.
- Never ship a user-visible change without a changeset — CHANGELOG.md's per-release entries are how users learn what changed.
- Never leave README.md's commands table or flag list disagreeing with `src/cli.ts`.
