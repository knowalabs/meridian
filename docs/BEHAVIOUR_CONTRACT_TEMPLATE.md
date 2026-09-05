A fill-in template for pinning down what "correct" means for a piece of Meridian behavior _before_ changing it — required whenever a change is more than a pure refactor (see `.meridian/rules.md`'s rule that "a behavior change is never bundled into a refactor"). Copy this into the PR description or a scratch file, fill it in, then implement.

## What behavior is this about?

Name the exact entry point: a CLI command (`meridian <command>`), an exported function (`file.ts`'s `functionName`), or a user-visible output shape (a `--json` document field). One sentence — if it takes more than one, the scope is too big for one contract.

## Current observable behavior

What does it do today, verified by reading the code or running it — not assumed. Cite the file and function. If tests already assert this behavior, name them (e.g. `tests/router-network.test.ts`'s "retries on 429, then succeeds").

## Desired observable behavior

What should it do after the change? State it as an input → output pair, not as an implementation instruction. If this changes a `CliError` message, hint, or exit code, state the exact new text/code — those are part of the public surface per [conventions.md](conventions.md)'s error-handling section.

## Inputs that must keep working

List the inputs (flags, config values, provider responses, malformed data) the current behavior handles that the new behavior must not regress. For anything touching `src/generate/*` or `src/providers/router.ts`, explicitly list the test-seam inputs (`setFetchForTests`, `setRunForTests`) that already cover this path.

## Inputs that are explicitly out of scope

State what this change does _not_ need to handle — an edge case being explicitly deferred is not the same as an edge case being missed. Absence of a caveat here reads as a guarantee, per this suite's own standard.

## Verification

The exact test(s) that will fail before the change and pass after — write these first (test-driven), not after implementing. Name the file: a new case in an existing `tests/*.test.ts`, or a new `tests/e2e/*.test.ts` case if this touches `src/cli.ts`, `src/launcher.ts`, or end-to-end file-writing behavior (neither is measured by `test:coverage`).

## Rollback

If this ships and is wrong, what is the smallest revert? For anything touching `.meridian/manifest.json`'s format, `src/rules/generators.ts`'s mirror output, or the vault's stored format, state explicitly whether existing on-disk state from before the change stays readable.

## Related

- `.meridian/rules.md` — the rule requiring a behavior change to ship as its own change, with a test that fails before and passes after.
- [conventions.md](conventions.md) — error-handling and typing conventions a filled-in contract must respect.
- [engineer-workflow.md](engineer-workflow.md) — the verification chain to run once the contract's test passes.
