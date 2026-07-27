# Review a DevPilot Pull Request

## When to use

Before merging a PR that touches `src/**/*.ts` or `tests/**/*.ts` in `@sonalsithara/devpilot` — the CLI that makes other codebases AI-assistant-ready.

## Context

- Node.js/TypeScript CLI (`devpilot`), ESM only (`"type": "module"`), strict `tsconfig.json` with `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
- Relative imports must use explicit `.js` extensions (NodeNext resolution) — e.g. `import './core/colorflag.js'` in `src/index.ts`.
- ESLint (`eslint.config.js`) errors on `src/**` for `@typescript-eslint/no-explicit-any`, `no-floating-promises`, `no-misused-promises`.
- Module boundaries: `src/commands/*.ts` are thin adapters (parse/validate, call `core`/`generate`/`providers`/`scan`, return an exit code) — no business logic in a Commander `.action()`. `src/scan/analyzer.ts` is read-only and must never write files. Only `src/generate/` and `src/rules/generators.ts` write generated output.
- Commands never call `process.exit()` — every action returns a number and `src/cli.ts`'s `done()` closure sets `process.exitCode`, because `src/launcher.ts` runs commands in-process (`buildCli({ exitOverride: true }).parseAsync`) and a raw exit would kill the interactive TUI.
- User-facing failures throw `CliError` (`src/core/errors.ts`) with an actionable `hint`, never a raw `Error` — see the pattern in `src/providers/router.ts`'s `classifyStatus`.
- Any AI-suggested or dynamically constructed file path in `src/generate/*.ts` must be validated through `isAllowedPath` (`src/generate/artifacts.ts`) — never bypassed.
- Side-effecting singletons (network, subprocess) expose a `setXForTests(impl | null)` seam — see `setFetchForTests`/`setRunForTests` in `src/providers/router.ts` — instead of a mocking library.
- Secrets avoid `argv` where possible (stdin-based `security -i`, `secret-tool`) per `KeychainVault.set`/`SecretToolVault.set` in `src/core/vault.ts`; secret file writes use `writeFileAtomic` (`src/core/fsx.ts`) with `mode: 0o600`.
- `src/index.ts` imports `./core/colorflag.js` first, before anything else — reordering breaks `--no-color`.

## Task

1. Read the diff in full before commenting on any single hunk.
2. Check module placement: does new logic in `src/commands/*.ts` belong there, or should it live in `core`/`generate`/`providers`/`scan`? Flag business logic sitting directly in a `.action()` callback.
3. Check for any `process.exit()` call in `src/commands/*` or code reachable from the launcher — this is a hard violation.
4. Check every user-facing failure path throws `CliError` with a `hint`, not a raw `Error` or a silent `console.error`.
5. If the diff touches `src/generate/*.ts`, confirm every AI-suggested or constructed path goes through `isAllowedPath` before being written, and that a failed/incomplete AI response still writes nothing (fail-closed — see `generateKind` in `src/generate/pipeline.ts`).
6. Check relative imports use `.js` extensions, and that no new `any` type, floating promise, or unchecked indexed access was introduced (`noUncheckedIndexedAccess` means `arr[i]` is possibly `undefined`).
7. If the diff adds a new side-effecting singleton, confirm it exposes a `setXForTests` seam rather than requiring a mocking library in tests.
8. If secrets or vault code changed, confirm no secret reaches `argv` and any new sensitive file write uses `writeFileAtomic` with an explicit `mode`.
9. Do not speculate — every finding must cite a `file:line`. If you can't point at the line, drop the claim.
10. Do not approve, merge, or push anything — this is a read-only review. Flag anything destructive (publish gating changes in `.github/workflows/ci.yml`, tag pushes) as a hard stop requiring explicit human confirmation.

## Output

A findings list ordered most-severe first. Each finding: `file:line`, the concrete rule violated (quote the CLAUDE.md/convention it breaks), why it matters here, and the smallest fix. End with a one-line verdict: approve, approve with nits, or request changes.

```
<paste the PR diff here>
```
