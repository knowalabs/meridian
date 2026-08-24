# Conventions

Real naming, file-organization, import, typing, error-handling and tooling conventions actually in force in this codebase, each proven against a file. Read this before writing new code in `src/` or `tests/`. Not covered: conventions for a _target_ project `meridian generate` scans — those are whatever that project already does, discovered by `src/scan/analyzer.ts`, not imposed by this file.

## Naming

| Convention                            | Example                                                                                                          | Where                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| PascalCase for types/interfaces       | `ProviderSpec`, `ArtifactKind`, `GenerateResult`                                                                 | `src/providers/router.ts`, `src/generate/artifacts.ts`, `src/generate/pipeline.ts`                                               |
| camelCase for functions/variables     | `buildDigest`, `pickProvider`, `isAllowedPath`                                                                   | throughout `src/generate/`                                                                                                       |
| UPPER_SNAKE_CASE for module constants | `PROVIDERS`, `ARTIFACT_KINDS`, `FORMAT_SPEC`, `DEFAULT_TIMEOUT_MS`, `MCP_REGISTRY`, `TOOL_SPECS`, `RULE_TARGETS` | `src/providers/router.ts`, `src/generate/artifacts.ts`, `src/mcp/registry.ts`, `src/plugins/tools.ts`, `src/rules/generators.ts` |

## File organization

One file per module area in `src/commands/*.ts` (`ask.ts`, `auth.ts`, `doctor.ts`, `generate.ts`, `install.ts`, `mcp.ts`, `sync.ts`, `update.ts`) — a new subcommand gets its own file, registered in `src/cli.ts`, never inline logic in a `.action()` callback. Tests mirror this one-to-one: `tests/<area>.test.ts` per module area (`analyzer`, `commands`, `config`, `doctor`, `errors`, `fsx`, `generate`, `ignore`, `launcher`, `mcp`, `platform`, `plugins`, `prompt`, `router`, `router-network`, `rules`, `sync`, `update-ask`, `vault`, `vault-backends`, `workspaces`), plus `tests/e2e/` for the built binary.

## Imports

Relative imports use explicit `.js` extensions even though the source is `.ts`, per NodeNext module resolution — e.g. `import './core/colorflag.js'` in `src/index.ts`, `import { analyzeProject } from '../scan/analyzer.js'` throughout `src/generate/`.

## Typing

`tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. `noUncheckedIndexedAccess` means every indexed access (`arr[i]`, `record[key]`) types as possibly `undefined`; the codebase leans on non-null assertions after a proven-safe access rather than optional chaining everywhere — e.g. `match[1]!`, `match[2]!` in `extractFileSymbols` (`src/scan/analyzer.ts`) right after a successful regex match. `eslint.config.js` sets `@typescript-eslint/no-explicit-any: 'error'` on `src/**` — no `any` in source; the same file relaxes `no-unsafe-*` and `require-await` only for `tests/**`, since tests assert on parsed JSON output constantly.

## Error handling

Every user-facing failure throws `CliError` (`src/core/errors.ts`), never a raw `Error`, always with an actionable `hint` — see `classifyStatus` in `src/providers/router.ts` (`hint: 'Run "meridian auth ${ctx.provider}"...'`) and `FileVault.readAll`'s catch block in `src/core/vault.ts` (`hint: '...run "meridian keys repair"...'`). `@typescript-eslint/no-floating-promises` and `no-misused-promises` are `error` on `src/**` (`eslint.config.js`) — every promise is `await`ed or explicitly `void`ed.

## Test seams instead of a mocking library

Side-effecting singletons expose a `setXForTests(impl | null)` seam: `setFetchForTests`/`setRunForTests`/`setRetryDelayForTests` in `src/providers/router.ts`, exercised with `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` in `tests/router-network.test.ts` — never real network calls or real `setTimeout` delays in a test.

## File writes and secrets

Any write that must be atomic or permissioned goes through `writeFileAtomic` (`src/core/fsx.ts`); secret/sensitive files pass `mode: 0o600` explicitly — `indexWrite` and `FileVault.masterKey`/`writeAll` in `src/core/vault.ts`. Secrets avoid `argv` where possible: `KeychainVault.set` tries `security -i` (stdin) before an argv fallback, `SecretToolVault.set` always uses stdin (`src/core/vault.ts`).

## Formatting and linting

Prettier formats everything (`npm run format` writes, CI's `npx prettier --check .` verifies, per `.github/workflows/ci.yml`) — do not hand-format or fight it. ESLint (`eslint.config.js`) extends `typescript-eslint`'s `recommendedTypeChecked` with `projectService: true`, plus `eslint-config-prettier` last to disable stylistic rules Prettier already owns; `@typescript-eslint/no-unused-vars` allows an `argsIgnorePattern: '^_'` for intentionally unused parameters.

## Related

[architecture.md](architecture.md) for where each convention's module lives, [engineer-workflow.md](engineer-workflow.md) for the exact commands that enforce these, [security.md](security.md) for the secrets-specific rules above in full.
