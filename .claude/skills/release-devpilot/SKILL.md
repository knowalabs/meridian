---
name: release-devpilot
description: Use when preparing a new DevPilot release — version bump, CHANGELOG entry, and a tag matching the CI publish gate.
---

# Release DevPilot

## When to use

Cutting a new version of `@sonalsithara/devpilot` for npm publish. This is a destructive/hard-to-reverse workflow — every step below stops for explicit user approval before acting, per `CLAUDE.md`'s safety rules.

## Before you start

- @package.json — current `version`, and the `prepublishOnly` script (`npm run build`)
- @CHANGELOG.md — this repo's real release-notes shape: `## X.Y.Z` followed by `### Minor Changes` (or similar) bullets, each explaining the _why_, not just the _what_
- @.github/workflows/ci.yml — the `publish` job: it only runs on `refs/tags/v*`, and its "Verify tag matches package version" step fails the whole job if the tag isn't exactly `v` + `package.json`'s `version`
- @CLAUDE.md — "Never run `npm publish`, push git tags matching `v*`, or modify `NPM_TOKEN`/CI secrets from an assistant session"

## Steps

1. Confirm the working tree is clean, then run the full verification chain (see `@.claude/skills/verify/SKILL.md`) before touching any release file — a release must never ship on a red run.
2. Decide the version bump (patch/minor/major) with the user, consistent with how prior entries in `CHANGELOG.md` are scoped ("Minor Changes" for each notable feature).
3. Update `package.json`'s `version`, and prepend a new `## X.Y.Z` section to `CHANGELOG.md` in the same structure as the existing entries — lead with the change, follow with why it matters (this repo has `@changesets/cli` as a devDependency; match its release-notes voice even if not run through it here).
4. Show the exact diff (`package.json` + `CHANGELOG.md`) to the user and wait for approval before committing — use `@.claude/skills/commit/SKILL.md` for the commit itself.
5. After the commit is approved and made, propose the tag `v<version>` (must equal `v` + the new `package.json` version exactly, or `ci.yml`'s publish job's version check fails). Ask before creating or pushing the tag — pushing it is what triggers CI's publish job.
6. Do not run `npm publish` locally under any circumstance — CI's `publish` job does that on the tag push, using `NODE_AUTH_TOKEN`/provenance.

## Verification

`npm run format`, `npm run lint`, `npm run build`, `npm run test:coverage`, `npm run test:e2e` — all green before step 2. After tagging (only once pushed by the user), the real verification is watching CI's `test` job pass across its OS/Node matrix before `publish` runs.

## Done when

- [ ] `package.json` version and `CHANGELOG.md` are updated together, in one approved commit.
- [ ] The verification chain was green before the version bump.
- [ ] The tag exactly matches `v<package.json version>`.
- [ ] The user explicitly approved the tag push (not assumed).

## Never

- Never run `npm publish` from this session.
- Never push a `v*` tag without the user's explicit approval for that push.
- Never modify `.github/workflows/ci.yml`'s publish gating (tag-vs-version check, `refs/tags/v*` trigger) as part of a release.
- Never force-push or amend a release commit.
