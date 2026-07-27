---
name: review-diff
description: Use to review the current diff against DevPilot's module boundaries and code-style conventions before it is committed.
---

# Review Diff

## When to use

Before committing or opening a PR, to check a change against this repo's actual architectural boundaries and style rules — not a substitute for `@.claude/skills/verify/SKILL.md` (which runs the automated checks) or `@.claude/skills/commit/SKILL.md` (which stages and commits).

## Before you start

- @CLAUDE.md — full module-boundary list and Code Style / Safety sections
- @.devpilot/rules.md — the canonical mirror of the same rules
- @docs/architecture.md
- @docs/conventions.md

## Steps

1. Run `git diff` (or `git diff --cached` if reviewing what's staged) to see the actual change set — review the diff itself, not a description of it.
2. Check module boundaries: `src/commands/*.ts` stay thin (parse/validate/call-into-core/return exit code — no business logic inside a Commander `.action()`); `src/scan/analyzer.ts` stays read-only; only `src/generate/` and `src/rules/generators.ts` write generated output; platform-specific logic in `src/core/vault.ts` stays isolated per backend class (`KeychainVault`/`SecretToolVault`/`DpapiProtector`/`PlainProtector`), not scattered as inline `if (platform === …)` checks elsewhere.
3. Check code-style guarantees: no `@typescript-eslint/no-explicit-any` violations, relative imports keep explicit `.js` extensions, every user-facing failure throws `CliError` with an actionable `hint`, no floating/misused promises.
4. Check that any new side-effecting singleton (network, subprocess) exposes a `setXForTests(impl | null)` seam like `setFetchForTests`/`setRunForTests` in `src/providers/router.ts`, instead of pulling in a mocking library.
5. Check safety rules: no `process.exit()` anywhere in `src/commands/*` or launcher-reachable code; no secret material added to `keys/index.json`-style files; any AI-suggested path in `src/generate/` routed through `isAllowedPath`.
6. Report findings as file:line with the concrete rule violated — don't just say "looks fine."

## Verification

`npm run format` (or `npx prettier --check .`), `npm run lint`, `npm run build` — resolve everything this review flags, then hand off to `@.claude/skills/verify/SKILL.md` for the full chain and `@.claude/skills/commit/SKILL.md` to commit.

## Done when

- [ ] Every changed file was checked against the module-boundary list relevant to its directory.
- [ ] Any `CliError`-worthy failure path has a `hint`.
- [ ] No `process.exit()` was introduced in `src/commands/*` or launcher-reachable code.
- [ ] Findings (if any) are reported with file:line, not general impressions.

## Never

- Never approve a diff that writes generated output from outside `src/generate/`/`src/rules/generators.ts`.
- Never approve a diff that touches `.github/workflows/ci.yml`'s publish gating without flagging it for explicit confirmation.
- Never approve a diff that bypasses `isAllowedPath` for an AI-suggested or dynamically constructed file path.
