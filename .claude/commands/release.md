---
description: Prepare a DevPilot release matching the CI publish gate
---

Prepare a release for `@sonalsithara/devpilot` (current version in `package.json` — check it first). Context: `$ARGUMENTS` (e.g. target version or "patch"/"minor"/"major").

1. Confirm the full verify loop is green first: `npm run lint`, `npx prettier --check .`, `npm run build`, `npm run test:coverage`, `npm run test:e2e`.
2. Bump the `version` field in `package.json` (this repo uses `@changesets/cli` — check for pending changesets and consolidate the changelog entry).
3. Update `CHANGELOG.md` with a concise entry describing what shipped, matching the style of recent entries (e.g. "Bump version to X and update CHANGELOG: ...").
4. Do NOT create or push the `vX.Y.Z` git tag yourself — tagging triggers `.github/workflows/ci.yml`'s `publish` job, which runs `npm publish --provenance` using `NPM_TOKEN`. Only the user pushes release tags.
5. Remind the user: the `publish` job hard-fails if the tag doesn't exactly match `package.json`'s version (`node -e` check in `ci.yml`), so the version bump commit must land before the tag is pushed.
6. Never modify `.github/workflows/ci.yml`'s publish gating, run `npm publish` directly, or touch `NPM_TOKEN`/CI secrets — these require explicit user action outside this session.
