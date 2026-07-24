# Review a Pull Request in DevPilot

Review the following diff against `@sonalsithara/devpilot`'s conventions. This is a strict-TypeScript, ESM-only Node.js CLI (`devpilot`) — do not conflate "the target project" (what `devpilot generate` scans) with this repo itself.

Check every item below and call out violations with file:line references. Skip items that don't apply to this diff.

**Module boundaries**

- Commands in `src/commands/*.ts` stay thin — parse/validate input, delegate to `core`/`generate`/`providers`/`scan`, return an exit code via the `done()` wrapper pattern in `src/cli.ts`. Flag any business logic sitting directly inside a Commander `.action()` callback.
- No `process.exit()` anywhere in `src/commands/*` or code reachable from `src/launcher.ts` — it would kill the interactive TUI session after one action. Exit codes flow through `process.exitCode` only.
- `src/scan/analyzer.ts` must stay read-only — it must never write files.
- Generated output (`.devpilot/`, `CLAUDE.md`, `AGENTS.md`, etc.) is written only from the `generate` pipeline (`src/generate/pipeline.ts`) and `src/rules/generators.ts` — flag any other module writing to those paths.
- `src/index.ts` must import `./core/colorflag.js` first, before anything else — it mutates `NO_COLOR`/color state before `picocolors` reads it at load time. Flag any reordering of that import.

**Generate pipeline invariants** (if the diff touches `src/generate/*.ts`)

- Any AI-suggested or dynamically constructed file path must be validated through `isAllowedPath` (`src/generate/artifacts.ts`) before writing — never bypassed.
- A new/changed `ArtifactKind` in `ARTIFACT_KINDS` must supply both `prompt(digest)` and `fallback(analysis)`.
- `generateKind` in `src/generate/pipeline.ts` is fail-closed: a failed AI call must write nothing for that kind, never silently fall back to the static template mid-run. Flag any change that weakens this.

**Code style**

- Strict TypeScript: no `any` (`@typescript-eslint/no-explicit-any` is `error` on `src/**`), no floating/misused promises, `noUncheckedIndexedAccess` respected (explicit checks on indexed access, no unchecked `!`).
- Relative imports use explicit `.js` extensions (NodeNext resolution) — flag any `.ts` or extensionless relative import.
- User-facing failures throw `CliError` (`src/core/errors.ts`) with an actionable `hint`, never a raw `Error`.
- Side-effecting singletons (network, subprocess) expose a `setXForTests(impl | null)` seam like `setFetchForTests`/`setRunForTests` in `src/providers/router.ts` — flag any new mocking-library usage instead.
- File writes needing atomicity/permissions go through `writeFileAtomic` (`src/core/fsx.ts`); secrets use `mode: 0o600` explicitly.
- Secrets avoid `argv` where possible (stdin-based invocation, per `KeychainVault.set`/`SecretToolVault.set` in `src/core/vault.ts`).
- Naming: PascalCase types/interfaces, camelCase functions/variables, `UPPER_SNAKE_CASE` module constants.

**Testing**

- Changes to `src/generate/*.ts` keep `isAllowedPath`/`parseFileBlocks` coverage current in `tests/generate.test.ts`.
- Changes to `src/providers/router.ts` network/retry/timeout behavior use `setFetchForTests`/`setRunForTests` + `vi.useFakeTimers()`/`vi.advanceTimersByTimeAsync` — no real network calls or real `setTimeout` delays.
- Tests sandbox filesystem/vault state via `process.env.DEVPILOT_HOME` (temp dir) and `process.env.DEVPILOT_VAULT = 'file'`, cleaned up in `afterEach` — never touch the real OS keychain or `~/.devpilot`.
- New source files shouldn't drag coverage below the `vitest.config.ts` thresholds (70% lines, 60% branches over `src/**/*.ts`, excluding `src/launcher.ts`/`src/index.ts`).

**Safety**

- No real API keys/tokens/vault contents written to disk outside `core/vault.ts`'s backends; `keys/index.json` stores only account names.
- `.github/workflows/ci.yml`'s publish gating (tag-vs-version check, `refs/tags/v*` trigger) is untouched unless explicitly requested.
- `DpapiProtector`'s legacy plain-hex fallback in `unprotect` is not removed (backward compatibility for pre-`dpapi:` stored keys).

Here is the diff:

```
<paste diff here>
```
