# Onboarding — @sonalsithara/meridian (for AI assistants)

## Project in one paragraph

Meridian is a Node.js/TypeScript CLI (`meridian`) that makes _other_ codebases AI-assistant-ready with one command (`meridian generate`), plus manages AI tool installs (`doctor`/`install`), API key storage (`auth`/`keys`), an MCP server marketplace (`mcp`), and AI request routing (`ask`/`router`). Strict TypeScript, ESM-only, zero runtime dependencies beyond `commander` and `picocolors`. Read `src/generate/pipeline.ts` (`runGenerate`) before touching the `generate` flow — it is the flagship path.

## Where to make common kinds of changes

| Change you want to make                                      | Where it goes                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add/modify a CLI subcommand                                  | Register in `src/cli.ts`; implement the action in a new/existing `src/commands/*.ts` file, kept thin                                                                                                                           |
| Add a new AI provider (hosted API or keyless CLI)            | `src/providers/router.ts` — add to `PROVIDERS: ProviderSpec[]` with relative `cost`/`speed`/`quality`/`contextTokens`; use `post()` for HTTP or `runImpl`/`which` for CLI-backed. There's a skill for this: `add-ai-provider`. |
| Add a new generated artifact kind (like rules/agents/skills) | `src/generate/artifacts.ts` — add to `ARTIFACT_KINDS`, must supply both `prompt(digest)` and `fallback(analysis)`, plus `allowedPaths`. There's a skill for this: `add-artifact-kind`.                                         |
| Change how `.meridian/rules.md` propagates into tool configs | `src/rules/generators.ts` — never hand-edit `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` directly and expect it to stick                                                                                                                |
| Change the target-project digest/analysis                    | `src/scan/analyzer.ts` (static facts, read-only) and `src/generate/digest.ts` (`buildDigest`, prompt text assembly)                                                                                                            |
| Change secret storage behavior                               | `src/core/vault.ts` — add/modify a backend class (`KeychainVault`, `SecretToolVault`, `DpapiProtector`, `PlainProtector`), keep platform logic isolated per class                                                              |
| Change global CLI flags (`--verbose`, `--json`, etc.)        | `src/cli.ts`'s `addGlobalFlags`                                                                                                                                                                                                |
| Change the interactive menu (bare `meridian`)                | `src/launcher.ts` — not unit-tested by design, verify manually                                                                                                                                                                 |
| Add/modify MCP marketplace behavior                          | `src/mcp/` and `src/commands/mcp.ts`                                                                                                                                                                                           |
| Add/modify per-tool install logic                            | `src/plugins/`                                                                                                                                                                                                                 |
| Error messages / exit codes                                  | `src/core/errors.ts` — always throw `CliError` with an actionable `hint`, never a raw `Error`                                                                                                                                  |

## Exact commands to run and verify

Run in this order (mirrors `.github/workflows/ci.yml` exactly):

```bash
npm run format         # prettier --write .   (or: npx prettier --check . to check only)
npm run lint           # eslint src tests
npm run build          # tsc -p tsconfig.build.json
npm run test:coverage  # vitest run --coverage
npm run test:e2e       # only if the change touches generate, cli.ts, or an e2e-exercised path
                        # (pretest:e2e runs `npm run build` first automatically)
```

Other useful scripts: `npm run dev` (runs `tsx src/index.ts` directly, no build step), `npm test` (`vitest run`, no coverage), `npm run test:watch` (`vitest` watch mode).

There's also a `verify` skill that runs this full loop in CI order and fixes failures — use it when finishing a change.

## Testing conventions

- Vitest. Unit/integration tests: `tests/*.test.ts`, one file per module area (`analyzer`, `commands`, `config`, `errors`, `fsx`, `generate`, `launcher`, `mcp`, `platform`, `plugins`, `prompt`, `router`, `router-network`, `rules`, `update-ask`, `vault-backends`, `vault`). E2E tests: `tests/e2e/`, separate config `vitest.e2e.config.ts`.
- Coverage thresholds (`vitest.config.ts`): 70% lines, 60% branches, over `src/**/*.ts` excluding `src/launcher.ts` and `src/index.ts` — a new module must not drag these below threshold.
- Any change to `src/generate/*.ts` must keep the `isAllowedPath`/`parseFileBlocks` invariants covered — extend the existing `describe` blocks in `tests/generate.test.ts` rather than writing ad hoc scripts.
- Any change to `src/providers/router.ts` network/retry/timeout behavior must use `setFetchForTests`/`setRunForTests` plus `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` (see `tests/router-network.test.ts`) — never add real network calls or real `setTimeout` delays in tests.
- Sandbox filesystem/vault state via `process.env.MERIDIAN_HOME` (temp dir) and `process.env.MERIDIAN_VAULT = 'file'`; clean up in `afterEach` with `fs.rmSync(..., { recursive: true, force: true })` — never touch the real OS keychain or the developer's real `~/.meridian`.

## Gotchas visible in the code

- **Import order in `src/index.ts`**: `./core/colorflag.js` must be imported _first_, before anything that pulls in `picocolors` — it mutates `NO_COLOR`/color state before `picocolors` reads it at module-load time. Reordering silently breaks `--no-color`.
- **Never `process.exit()` in a command.** `src/cli.ts` actions call `done(code)` which sets `process.exitCode`; a raw `process.exit()` in anything reachable from `src/launcher.ts` kills the whole interactive TUI session after one action.
- **AI generation is fail-closed, not fail-open.** In `generateKind` (`src/generate/pipeline.ts`), a failed AI call writes _nothing_ for that kind rather than silently substituting the static fallback — intentional, so a later re-run retries with AI, but it means one flaky provider call can leave a kind entirely unwritten.
- **`--force` semantics**: `generate` skips files that already exist by default (`skipped-exists`); don't assume a bare re-run regenerates everything.
- **`isAllowedPath` is mandatory, not optional**, for any AI-suggested or dynamically constructed path — it blocks absolute paths, Windows drive letters, and `..` traversal, and is the only guard against a malformed/adversarial AI response writing outside the project. Never bypass it.
- **CLI-backed providers use a sentinel model** `CLI_DEFAULT_MODEL = 'cli-default'` (`src/providers/router.ts`), meaning "use whatever the signed-in CLI is configured with" — `modelFor()` won't always return a real model string for `claude-code`/`codex-cli`/`gemini-cli`.
- **Timeout differs by provider type**: HTTP providers use `DEFAULT_TIMEOUT_MS = 60_000`; `claude-code` (and other CLI-backed providers) use `timeoutMs: 600_000` since they shell out to a full CLI session — don't reuse the HTTP default for new CLI-backed providers.
- **Neither macOS Keychain nor Linux Secret Service can enumerate stored items** — `src/core/vault.ts` keeps a parallel, non-secret `keys/index.json` index under `meridianHome()`. Manipulating the OS vault outside Meridian's `set`/`delete` desyncs this index.
- **Windows vault (`DpapiProtector`) shells out to PowerShell** with base64 over stdin, not a native module — slower, and fails hard without PowerShell on PATH. Its legacy plain-hex fallback (`unprotect`) must stay for backward compatibility with keys stored before the `dpapi:` prefix existed — do not remove it.
- **Secrets avoid argv when possible** (`security -i` / `secret-tool` via stdin), but `KeychainVault.set` has an argv fallback if stdin mode fails — that path _does_ put the secret in `ps`-visible arguments; be careful touching it.
- **This repo's own `.meridian/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `README_AI.md` are dogfooded `meridian generate` output**, not hand-authored source — don't hand-edit them; change the generator (`src/generate/`, `src/rules/generators.ts`) instead.
- **Coverage excludes `src/launcher.ts` and `src/index.ts` on purpose** — don't treat low coverage there as a regression; they're verified by humans/e2e.
- **CI publish gating is strict and tag-driven**: the `publish` job in `.github/workflows/ci.yml` only runs on `refs/tags/v*` and hard-fails if the tag doesn't match `package.json`'s version. Never run `npm publish`, push a `v*` tag, or touch this gating logic from an assistant session without explicit confirmation.
