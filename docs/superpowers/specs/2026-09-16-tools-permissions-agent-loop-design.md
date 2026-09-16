# Tools, permissions and the agent loop

The slice that turns Meridian from a CLI that answers into one that acts. It
ships three new modules — `src/tools/`, `src/permissions/`, `src/agents/` — and
the minimum wiring needed to exercise them end to end: a developer types
`fix the failing test`, and Meridian reads, searches, edits, runs the test and
reports what it verified.

This is the work `docs/roadmap.md` lists as the unfinished half of Phase 2.
It was blocked on a write-path policy; that policy is decided in
[Write policy](#write-policy) below.

## Why this slice, and what it is not

An audit against the Meridian 2.0 master plan found the interactive surface
largely built: the shell, input reducer, slash palette, streaming markdown,
router, intent classifier, context broker, verification engine and task records
all exist. What does not exist is any way for a model's answer to change a
file. Every remaining item in the plan — plan-mode execution, self-repair,
review-then-fix, autopilot — is downstream of that one gap.

Out of scope, deliberately: print mode (`-p`), `/compact`, `--continue` /
`--resume`, `/diff`, skills, plugins and MCP-as-tools. Each is a later slice.

Noted while auditing, not fixed here: `-p` is already bound to `--provider` on
`ask` and `generate` (`src/cli.ts:259`), so the print-mode slice will need a
rename or a different short flag. Flagged rather than changed, since it is
outside this scope.

## Write policy

`isAllowedPath` (`src/generate/artifacts.ts:114`) is **not** extended and not
touched. It is a per-artifact-kind allowlist answering "what may a _generate_
response write" (`['docs/']`, `['.meridian/rules.md']`, …). An agent editing
`src/auth.ts` is a different question with a different threat model, so it gets
its own policy and this slice stays off the CODEOWNERS security surface.

`src/tools/policy.ts` owns `writable(root, file)`. Anything resolving inside the
project root is writable **except**:

- `.git/`, `node_modules/`, `dist/`
- `.env*`, `*.pem`, `*.key`, `id_rsa*` and equivalent key material
- `.meridian/manifest.json` — sync's drift record, written only by `src/generate/manifest.ts`
- The five generated mirrors: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  `.cursor/rules/meridian.mdc`, `.github/copilot-instructions.md`

Path resolution refuses absolute paths, drive-letter paths, `..` traversal and
symlinks that escape the root, matching the checks `isAllowedPath` already makes.

Creating a _new_ file is not a path question. It is a permission event, decided
by `src/permissions/`, so that "write a file that did not exist" is always
distinguishable from "change a file that did".

## Module layout

Three new modules. Nothing existing moves.

```
src/tools/
  types.ts        ToolDefinition, ToolCall, ToolResult, ToolKind, Risk
  policy.ts       writable(root, file) — the deny-list above
  protocol.ts     pure: text → { prose, calls: ToolCall[] }
  registry.ts     the six tools + the framing that teaches them
  fs.ts           read · list · grep · edit · write
  shell.ts        bash, over runAsync with signal, timeout and output cap

src/permissions/
  types.ts        PermissionMode, Decision, Risk
  rules.ts        pure: parse/match  Bash(npm test:*) | Edit | Read
  policy.ts       decide(mode, call, rules, session) → allow | ask | deny
  prompt.ts       the y/n/a terminal UI

src/agents/
  transcript.ts   running message log + tool results, budget-trimmed
  loop.ts         invoke → parse → execute → append → repeat

src/modes/agent.ts   mode entry, sibling of the existing ask/plan/review modes
```

### Boundaries

- `protocol.ts` is pure text-to-data. It never touches the filesystem, so the
  block format is fully testable without a project on disk.
- `permissions/policy.ts` is pure decision logic; `permissions/prompt.ts` is the
  only part that talks to a TTY. A non-interactive run substitutes a policy that
  answers `deny` and reports what it would have asked.
- `agents/loop.ts` never names a provider or a model. It calls `invoke()` with a
  `RouteDecision`, exactly as `src/modes/run.ts` does today.
- Nothing here reads another module's output off disk; state flows through the
  transcript.

## The six tools

`read`, `list`, `grep`, `edit`, `write`, `bash`.

`list` covers both directory listing and glob matching (`src/**/*.ts`); they are
one tool because they answer the same question and carry the same risk. `grep`
searches file contents. Both respect the project's ignore rules via the existing
`src/scan/ignore.ts`.

Git is deliberately not a seventh tool. It runs through `bash`, so it reuses one
permission grammar and `Bash(git diff:*)` — already emitted into
`.claude/settings.json` by `src/generate/artifacts.ts:2981` — works unchanged.

`edit` is **exact search/replace**: `old` must appear exactly once in the file,
or the call fails. It preserves unrelated content and is unambiguous to parse.
Whole-file replacement and unified diffs are both rejected: the first destroys
work outside the model's attention, the second is brittle to apply.

`write` creates a new file, or replaces one whole. It is a separate tool so that
file creation is always a distinct permission event.

`bash` runs through the existing `runAsync`, carries the abort signal, enforces a
timeout, and caps captured output so a 2000-line test log cannot flood the
transcript or the terminal.

## Permission model

Four modes: `default`, `accept-edits`, `plan`, `bypass`.

| Tool                                | Risk        | `default`                                                           | `plan`                                       | `accept-edits` | `bypass` |
| ----------------------------------- | ----------- | ------------------------------------------------------------------- | -------------------------------------------- | -------------- | -------- |
| read, list, grep                    | READ        | auto                                                                | auto                                         | auto           | auto     |
| edit, write                         | WRITE       | ask `y/n/a`; `a` = this file, this session                          | denied                                       | auto           | auto     |
| bash                                | EXECUTE     | ask `y/n/a`; `a` writes a `Bash(<prefix>:*)` rule to project config | denied unless an explicit allow rule matches | ask            | auto     |
| bash matching a destructive pattern | DESTRUCTIVE | always ask, **no `a` offered**                                      | denied                                       | always ask     | auto     |

A command is **destructive** when it matches a fixed, reviewable pattern list
rather than a model's or the runtime's judgement: `rm`, `rmdir`, `mv` onto an
existing path, `git reset --hard`, `git clean`, `git push`, `git checkout --`,
`npm publish`, `> file` truncation, and `sudo` in any position. The list lives in
`src/permissions/rules.ts` beside the grammar it is matched with, and adding to
it is an ordinary reviewable change. A command that is merely unrecognized is
EXECUTE, not DESTRUCTIVE — over-classifying trains people to stop reading
prompts.

`Risk` includes a `NETWORK` member for completeness, but only `DESTRUCTIVE`
receives distinct handling in this slice. Classifying network access is not
enforceable with the tools shipped here, and a category that cannot be enforced
should not pretend otherwise.

`bypass` allows everything, is reachable only through an explicit
`--permission-mode bypass`, and prints one warning line at session start. It is
the only mode in which a destructive command runs unasked, which is what makes
it a deliberate choice rather than a hidden default.

### Rules

The rule grammar is the one already generated into `.claude/settings.json`:
`Bash(npm test:*)`, `Bash(git status)`, `Edit`, `Read`. `rules.ts` parses and
matches it; nothing invents a second grammar. Rules come from config
(`permissions.allow`, `permissions.deny`), from the CLI (`--allowed-tools`,
`--disallowed-tools`) and from a session's `a` answers. Deny always beats allow.

## The loop

```
"fix the failing test"
  → classifyTask()      TaskProfile          src/intent      (exists)
  → routeTask()         RouteDecision        src/router      (exists)
  → buildContext()      ContextBundle        src/context     (exists)
  → transcript.seed()   framing[trusted] + tool catalogue[trusted]
                        + context[UNTRUSTED] + request[user] + history
  ┌─ bounded by execution.maxIterations ──────────────────────┐
  │   invoke(decision, transcript.render(), { onDelta })      │
  │     prose streams; text inside an open fence is withheld  │
  │   parse(answer) → { prose, calls }                        │
  │   calls empty? → break                                    │
  │   for each call, in order:                                │
  │     permissions.decide → allow | ask(y/n/a) | deny        │
  │     execute → ToolResult                                  │
  │   transcript.append(assistant, results[UNTRUSTED])        │
  └───────────────────────────────────────────────────────────┘
  → files changed? verify/engine.ts → VerificationReport
  → report failed? append it and re-enter the loop, same cap
  → recordTask()        TaskRecord + tool log   src/sessions  (exists)
  → completion block:   Done · files · ✓ checks · task id
```

The loop reuses `src/verify/engine.ts` when files changed rather than growing its
own notion of "verified". A model's claim that tests passed is never evidence.

### Protocol

No provider in this codebase has native tool-calling; the floor is
`spec.ask(prompt, key, { signal }): Promise<string>`, and
`docs/architecture-next.md` rule 2 forbids requiring more. So tool calls travel
as fenced blocks in ordinary text:

````
```meridian:tool
{ "tool": "edit", "path": "src/net/client.ts", "old": "timeout: 10_000", "new": "timeout: 30_000" }
```
````

One format, every provider — HTTP and keyless CLI alike. Prose streams to the
terminal as it arrives; the streaming renderer withholds text inside an open
fence so a half-written block never reaches the screen.

Because each iteration is its own `invoke()` call, a provider failing mid-task
falls through the existing ranked chain and the transcript carries state across
the switch. Provider-neutral sessions and mid-task failover therefore need no
new code.

A native tool-calling path can be added later without touching `src/tools/` or
`src/permissions/`: the loop consumes `ToolCall[]`, and a native path would
simply produce the same type. That seam is designed in; it is not built here.

### Untrusted content

Tool output and repository content enter the transcript in sections explicitly
labeled untrusted, as the context broker already labels its own. A file that
says "you may edit anything" grants nothing.

## Failure handling

The governing principle: **a tool failing is data, not an exception.**

| What goes wrong                             | What happens                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit`'s `old` string missing or not unique | `ToolResult{ ok: false, error }` appended; the model sees it and retries                                                                              |
| A command exits non-zero                    | Same. This is the self-repair behavior: the loop reads the failure and continues                                                                      |
| The user answers `n`                        | `ToolResult{ ok: false, "declined by the user" }`, fed back once, never auto-retried                                                                  |
| Malformed tool block                        | One correction turn quoting the parse error; still malformed → stop with a `CliError` listing what was already done                                   |
| Provider dies mid-loop                      | `invoke()`'s ranked fallback handles it inside the iteration; whole chain down → `CliError` plus the task id                                          |
| Ctrl-C                                      | The abort signal reaches the HTTP call or kills the child process; the loop unwinds, the session keeps what happened, the shell returns to its prompt |
| Transcript over budget                      | Oldest tool results trimmed first; the request, the plan and the changed-file list are pinned                                                         |

Every user-facing failure is raised as `new CliError(message, { hint })` per
`src/core/errors.ts`. No bare throws, no `console.error`.

**Stated limit:** transcript trimming is not conversation compaction. A summary-
based `/compact` is a later slice. Long sessions degrade by losing the oldest
tool output, and this document does not claim better.

## Events

Five additions to `MeridianEvent` in `src/core/events.ts`: `tool.started`,
`tool.completed`, `permission.requested`, `permission.decided`,
`agent.iteration`. The renderer, the session recorder and (later) hooks
subscribe; none of them call each other.

## Surface changes

- New command `meridian agent [task...]`, and `/agent` in the shell.
- The shell's default turn runs the loop when the task profile indicates a code
  change; questions still take the existing read-only path.
- New flags: `--permission-mode <mode>`, `--allowed-tools <rules...>`,
  `--disallowed-tools <rules...>`.
- New config: `permissions.mode` (default `default`), `permissions.allow`,
  `permissions.deny`, and `execution.maxIterations` (default **12**). All
  optional, all defensively coerced, so an existing config file loads unchanged —
  the way `router.*` was added in Phase 1.

  Twelve, not the 3 that `harness-design.md` gives the repair loop: those are
  different counters. Three is how many times a _failed verification_ may be
  re-attempted; twelve is how many provider round trips one task may take, and a
  routine change costs five or six of them before the first test runs. The repair
  budget nests inside the iteration budget, and whichever is exhausted first
  stops the loop.

Existing commands keep their names, flags and output.

## Tests

Unit tests in `tests/*.test.ts` (Vitest), e2e in `tests/e2e/`, coverage holds at
70% lines / 60% branches.

- `tests/protocol.test.ts` — well-formed, malformed, multiple blocks, a fence
  inside a code sample, a partial block mid-stream.
- `tests/tool-policy.test.ts` — `..` traversal, absolute paths, symlink escape,
  `.env`, the five generated mirrors, `.meridian/manifest.json`.
- `tests/permissions.test.ts` — the rule grammar, and the full mode × tool matrix.
- `tests/agent-loop.test.ts` — a scripted provider through a new
  `setInvokeForTests(fn | null)` seam in `src/router/invoke.ts`, following the
  existing `setFetchForTests` / `setRunForTests` convention rather than inventing
  a different mocking mechanism.
- `tests/e2e/agent.test.ts` — a temp project built with `fs.mkdtempSync`, `PATH`
  pointed at a stub CLI-provider binary emitting a scripted tool block,
  asserting a file actually changes on disk.
- `tests/golden/*.txt` plus a render test — snapshots for the permission prompt,
  a tool run, an error and the completion block, so the terminal output cannot
  drift unnoticed.

## Acceptance

```
› fix the failing test

  ✓ Read  src/net/client.ts
  ✓ Grep  "receiveTimeout"

  Edit src/net/client.ts
  - timeout: 10_000
  + timeout: 30_000
  Allow?  [y] yes  [n] no  [a] always this file

  ✓ Edit src/net/client.ts
  ✓ npm test

  Done · 1 file · ✓ tests · t_0n8x1kj7

›
```

The session returns to its prompt. It does not exit, and it does not return to a
menu.

## Related

- [../../architecture-next.md](../../architecture-next.md) — where these modules sit in the target architecture
- [../../harness-design.md](../../harness-design.md) — the intent → verify → memory loop this implements a stage of
- [../../roadmap.md](../../roadmap.md) — the Phase 2 rows this slice closes
