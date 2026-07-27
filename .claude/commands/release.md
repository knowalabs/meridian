---
description: Prepare a DevPilot release matching the CI publish gate
argument-hint: [version]
---

## Context

- `package.json`'s current `version` field
- `CHANGELOG.md` — entries follow the `@changesets/cli` format (`## x.y.z` / `### Minor Changes`), and `@changesets/cli` is a devDependency
- `.github/workflows/ci.yml`'s `publish` job — triggers on `refs/tags/v*`, and hard-fails unless the tag exactly matches `package.json`'s version

## Task

If `$ARGUMENTS` is empty, propose the next version from the nature of the unreleased changes (patch/minor/major) and ask the user to confirm before continuing.

1. Confirm the verify chain is green first: run `/verify` (or `npm run lint`, `npx prettier --check .`, `npm run build`, `npm run test:coverage`, `npm run test:e2e` in that order).
2. Bump the `version` field in `package.json` to `$ARGUMENTS` (or the confirmed version).
3. Add a `CHANGELOG.md` entry in the existing style (`## <version>` followed by `### Minor Changes`/`### Patch Changes`, one concise bullet per user-facing change) — if a `.changeset/` directory with pending changeset files exists, prefer running `npx changeset version` to generate this instead of hand-writing it.
4. Show the full diff (`package.json` + `CHANGELOG.md`) and **stop for explicit user approval** before committing anything.
5. After approval, create the commit. Do not create or push the `vX.Y.Z` tag yourself — show the exact `git tag vX.Y.Z` command and wait for the user to run it themselves, since pushing that tag triggers `ci.yml`'s `publish` job (`npm publish --provenance` using `NPM_TOKEN`).

## Report

The proposed version, the changelog entry, the diff awaiting approval, and the exact tag command the user still needs to run.

## Constraints

Never run `npm publish`, push a `v*` tag, or touch `NPM_TOKEN`/CI secrets from this session. Never modify `.github/workflows/ci.yml`'s publish gating. Never amend a prior commit or force-push. Treat any suspected secret in the diff as a hard stop with no "continue anyway" option.
