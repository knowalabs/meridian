# Implement a New Module Following Meridian's Architecture

## When to use

Adding new functionality to `@knowalabs/meridian` — a new command, a new `core` utility, a new plugin — that must slot into the existing module boundaries without violating them.

## Context

- Entry point `src/index.ts`: Node-version check, global error/signal handlers, dispatch to `src/launcher.ts` (bare `meridian` in a TTY) or `src/cli.ts` (`buildCli().parseAsync`). No command logic belongs here.
- `src/cli.ts` builds the Commander program and registers every subcommand plus global flags (`--verbose`, `-q/--quiet`, `--json`, `--no-color`) via `addGlobalFlags`. New subcommands are registered here, not ad hoc elsewhere.
- `src/commands/*.ts` — one file per command group (`doctor`, `install`, `auth`, `generate`, `sync`, `mcp`, `ask`, `update`). Each is a thin adapter: parse/validate input, call into `core`/`generate`/`providers`/`scan`, return an exit code via the `done()` pattern — never `process.exit()`.
- `src/core/` — cross-cutting infra: `errors.ts` (`CliError`, `EXIT`), `logger.ts`, `config.ts`, `vault.ts`, `fsx.ts` (`writeFileAtomic`, `backupFile`), `paths.ts` (`meridianHome`, `ensureHome`), `exec.ts` (`run`/`runAsync`/`which`), `spinner.ts`, `pkg.ts` (`VERSION`). Platform-specific logic is isolated per backend class (see `KeychainVault`/`SecretToolVault`/`DpapiProtector`/`PlainProtector` in `vault.ts`), not scattered `if (platform === …)` checks.
- `src/scan/analyzer.ts` — static analysis of the _target_ project, read-only, never writes.
- `src/generate/` — the AI-kit pipeline: `digest.ts`, `artifacts.ts` (`ARTIFACT_KINDS`, `isAllowedPath`), `pipeline.ts` (`runGenerate`). Any new artifact kind needs both a `prompt(digest)` and a `fallback(analysis)`.
- `src/providers/router.ts` — `PROVIDERS: ProviderSpec[]`, `route()`, shared HTTP `post()` with timeout/retry. New providers go in this array with `cost`/`speed`/`quality`/`contextTokens` set relative to existing entries.
- Strict TypeScript, ESM only, `.js` extensions on relative imports. `CliError` for user-facing failures, always with a `hint`. No floating promises. Naming: PascalCase types, camelCase functions, `UPPER_SNAKE_CASE` module constants.
- Verification order (mirrors `.github/workflows/ci.yml`): `npm run format` → `npm run lint` → `npm run build` → `npm run test:coverage` → `npm run test:e2e` (only if the change touches `generate`, `cli.ts`, or is exercised end-to-end).
- Tests: Vitest, one file per module area under `tests/*.test.ts`; sandbox filesystem/vault state via `process.env.MERIDIAN_HOME` (temp dir) and `process.env.MERIDIAN_VAULT = 'file'`, clean up in `afterEach`. Coverage thresholds: 70% lines, 60% branches over `src/**/*.ts` (excludes `src/launcher.ts`, `src/index.ts`).

## Task

1. State which existing module (`core`, `scan`, `generate`, `providers`, `rules`, `commands`, `mcp`, `plugins`) the new code belongs in, and why — cite the module's stated responsibility above.
2. If it's a new command, name the `src/commands/<name>.ts` file, the exit codes it returns, and the exact `program.command(...)` block to add to `src/cli.ts`.
3. List every new `CliError` site and its `hint` text.
4. If the module writes files, state which existing writer it should reuse (`writeFileAtomic`) and whether it needs `mode: 0o600`.
5. If the module makes a network or subprocess call, state the `setXForTests` seam it will expose.
6. Name the new `tests/<area>.test.ts` file and the sandboxing it needs (`MERIDIAN_HOME`, `MERIDIAN_VAULT`).
7. List the exact verification commands to run before calling the work done, in CI order.
8. Do not invent a file, script, or dependency not already present in this project — if something is missing (a package, a script), say so explicitly as a prerequisite rather than assuming it exists.
9. Any step that commits, pushes, publishes, or otherwise mutates shared state is out of scope — stop and ask before generating that step.

## Output

A file-by-file implementation plan (path → responsibility → key exports), followed by the actual code changes, followed by the exact test file and the ordered verification commands to run.

```
<describe the feature or module to add>
```
