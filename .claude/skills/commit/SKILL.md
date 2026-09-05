---
name: commit
description: Use before creating any git commit in this repo — walks staged-diff review, secret/red-flag scanning, and commit-message approval before anything is committed or pushed.
---

# Commit

## When to use

Use whenever you are about to run `git commit` in this repository, for any change — code, docs, or kit files. Not for choosing what to change or how (that's the workflow that produced the diff); this skill only covers turning a finished diff into a commit. Use `refactor` first if the change itself hasn't been made yet.

## Before you start

- @.meridian/rules.md — the working agreement this repo runs under.
- `git status` and `git diff --cached` — what is actually staged right now.
- CHANGELOG.md — the project's real commit/release vocabulary, to match tone.

## Steps

1. Run `git status` and `git diff --cached`. Summarize what is staged in one or two sentences. If nothing is staged, stop here and say so — unstaged changes are never part of the commit.
2. Scan the staged diff for secrets (API keys, tokens, anything that belongs in `openVault()` per `src/core/vault.ts`, never a plaintext file or argv per SECURITY.md). Also check this project's own red flags: a hand-edit to `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursor/rules/meridian.mdc`/`.github/copilot-instructions.md` staged without a matching `.meridian/rules.md` change (these are mirrors rendered by `src/rules/generators.ts` and must never diverge from their source), a manual `package.json`/`package-lock.json` version bump staged without going through `npx changeset version` (see the `release` skill), and leftover debug output or stray `console.log`. A secret is a hard stop, no override. Anything else: ask the user whether to continue.
3. Propose the full commit message and wait for approval, an edit, or a cancel. This repo's current convention (its last several commits, e.g. "Add the governance files a published package is missing", "Detect mirror targets before generate writes anything") is a single capitalized, imperative sentence stating what changed and, briefly, why — no `type(scope):` prefix. Older commits used Conventional Commits (`feat(generate): …`, `chore(kit): …`); match the current plain-sentence style unless the user asks otherwise.
4. Only commit after explicit approval. Never amend. Never `git add` anything beyond what the user approved, even if `git status` shows other tempting changes.
5. Ask before any push. Never force-push, never push a release tag without the same explicit approval (tagging a release is covered by the `release` skill, not this one).

## Verification

- `git status` after committing: working tree shows the commit landed and nothing unintended got swept in.
- `git log -1 --stat`: the file list matches exactly what was approved in step 3.

## Done when

- [ ] The commit exists with the approved message and only the approved files.
- [ ] `git status` shows no unintended staged/unstaged leftovers from this change.
- [ ] Nothing was pushed unless the user separately approved it.

## Never

- Never commit a secret, key, or token — hard stop, no "continue anyway".
- Never stage a rules-mirror file (CLAUDE.md, AGENTS.md, GEMINI.md, `.cursor/rules/meridian.mdc`, `.github/copilot-instructions.md`) edited by hand instead of via `.meridian/rules.md` + `meridian sync`.
- Never amend an existing commit or use `--no-verify`.
- Never push or force-push without asking first.
