---
name: commit
description: Use when the user asks to commit staged changes in this repo — walks through inspecting the stage, a secrets/red-flag scan, message approval, and an explicit push gate.
---

# Commit

## When to use

Whenever staged changes in this repo (`@sonalsithara/devpilot`) are ready to be committed. This is interactive and approval-gated end to end — it is not for staging files itself (the user or another step does that first) and not for pushing without a separate explicit ask.

## Before you start

- @.devpilot/rules.md — canonical rules (Safety section covers what never gets committed)
- @CLAUDE.md — module boundaries and the "Safety" list (no real API keys, no `keys/index.json` secret material, never touch `.github/workflows/ci.yml` publish gating without confirmation)
- @CHANGELOG.md — this repo's real commit-message tone: concise, rationale-driven ("why", not just "what")

## Steps

1. Run `git status` and `git diff --cached` (never plain `git diff` — unstaged changes are not part of this commit). Summarize what is staged in one or two sentences. If nothing is staged, stop here and say so.
2. Scan the staged diff for secrets/credentials/keys (API keys, tokens, `sk-…` strings, anything that looks like vault contents) — this is a **hard stop, no override**, per `CLAUDE.md`'s rule that secrets belong only inside `src/core/vault.ts`'s backends. Also flag, and ask before continuing on:
   - raw `console.log`/`console.error` in `src/` instead of `src/core/logger.ts`'s `log`
   - edits to generated output (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `README_AI.md`, `.devpilot/`) staged without a matching change to their real source (`src/rules/generators.ts`, `src/generate/artifacts.ts`)
   - leftover TODOs in the diff
   - any edit to `.github/workflows/ci.yml`'s publish gating (tag-vs-version check, `refs/tags/v*` trigger)
3. Propose a full commit message: an imperative, present-tense summary line, and — for anything user-facing — a short body explaining _why_, matching the rationale-first style `CHANGELOG.md`'s entries use (this repo has no commitlint/husky enforcing a format; the convention is observed, not tooled). Show it to the user and wait for approve, edit, or cancel.
4. Commit only after approval. Never amend an existing commit. Never `git add` anything beyond what the user already staged and approved.
5. Ask before any push. Never force-push.

## Verification

- `git status` after the commit — confirms exactly the approved files landed and the working tree matches expectations.
- If the commit touches `src/generate/*.ts` or `src/providers/router.ts`, confirm the relevant tests were already green before staging (see `@.claude/skills/verify/SKILL.md`) — this skill does not itself run the verification chain.

## Done when

- [ ] The commit contains only what was staged and approved.
- [ ] No secret or red flag was committed without an explicit user decision.
- [ ] The commit message matches what the user approved.
- [ ] Nothing was pushed without a separate explicit ask.

## Never

- Never commit when the secret scan hits — no "continue anyway" path.
- Never amend or force-push.
- Never stage or commit files the user did not approve.
- Never commit changes to `.github/workflows/ci.yml`'s publish gating without explicit confirmation.
