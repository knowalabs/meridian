---
name: release-devpilot
description: Use when preparing a new DevPilot release — version bump, changelog, and tag, matching this repo's CI publish gate.
---

# Releasing `@sonalsithara/devpilot`

Publishing to npm is fully gated by `.github/workflows/ci.yml`'s `publish` job, which only runs on a `refs/tags/v*` push and hard-fails if the tag doesn't match `package.json`'s version. Recent history (`64d3b16 Bump version to 0.8.0 and update CHANGELOG`) shows the established pattern: bump + changelog in one commit, then tag.

1. Confirm the working tree is clean and all changes for the release are already merged to `main` — the `test` job runs on every push/PR across `ubuntu-latest`/`macos-latest`/`windows-latest` × Node `18`/`20`/`22`, so don't tag until that matrix is green on `main`.
2. Run the full local verification in CI's exact order so a green local run predicts a green CI run: `npm run lint` → `npx prettier --check .` → `npm run build` → `npm run test:coverage` → `npm run test:e2e`.
3. Bump the `version` field in `package.json` (currently `0.8.0`) following semver based on the changes since the last tag.
4. Update `CHANGELOG.md` with the new version's entries, describing what changed — this repo's commit history shows the version bump and changelog update land together in one commit (e.g. `64d3b16`).
5. Commit the version bump + changelog together, then create a git tag `v<version>` (e.g. `v0.8.1`) matching `package.json` exactly — the `publish` job's `Verify tag matches package version` step does `node -e "...'v'+require('./package.json').version..."` and fails the whole job on any mismatch.
6. Do **not** run `npm publish` or push the `v*` tag from an assistant session — per this project's safety rules, tagging/pushing `refs/tags/v*` is what triggers the `publish` job (which itself runs `npm ci`, `npm run build`, `npm test`, then `npm publish --provenance` using the `NPM_TOKEN` secret and npm provenance via `id-token: write`). Prepare the version bump, changelog and tag locally/in a PR, and hand off the actual tag push/publish trigger to the human maintainer.
7. After the human pushes the tag and CI's `publish` job succeeds, `prepublishOnly` (`npm run build`) has already run as part of that job — no separate manual build step is needed post-tag.
