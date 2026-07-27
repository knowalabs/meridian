# Behaviour contract template

A fill-in template for writing down what a piece of DevPilot's behavior actually does _before_ changing it — so a change can be checked against what was true, not against memory. Copy this into your PR description or a scratch file when touching anything with non-obvious current behavior (retry logic, the vault backends, `isAllowedPath`, the manifest/sync drift rules). Not a doc about a specific module — it's the process to run against any of them.

## When to use this

Before changing behavior in a module where "what it currently does" isn't obvious from the function name alone — network retry/backoff (`src/providers/router.ts`), vault backend selection (`src/core/vault.ts`'s `openVault`), kit drift detection (`src/generate/manifest.ts`), or anything covered by an existing `tests/*.test.ts` file whose assertions you're about to touch.

## Template

```
### Behavior under contract

Module / function: <e.g. classifyStatus() in src/providers/router.ts>

### Current observable behavior (fill in from reading the code + running the tests)

Given: <input / state — e.g. "a 503 response on the 2nd of 3 attempts">
When:  <action — e.g. "post() is called">
Then:  <observable result — e.g. "sleeps backoffFor(2)ms, retries once more, then throws
        a CliError with the '3 times in a row' hint if attempt 3 also fails">

Evidence: <file:symbol or test name that proves this — e.g.
           "tests/router-network.test.ts: 'surfaces a persistent 5xx with a
           provider is having trouble hint'">

### Proposed change

What changes: <...>
What must NOT change (existing callers/tests relying on current behavior):
  - <e.g. "4xx errors outside RETRYABLE_STATUS must still throw on the first attempt">
  - <e.g. "streaming (postStream) must still never retry">

### Verification

- [ ] Existing tests for this behavior still pass, or are updated with a stated reason
- [ ] New/changed behavior has a corresponding test (see the sandboxing conventions in
      docs/conventions.md and the test-seam pattern — setFetchForTests/setRunForTests,
      never a real network call or real setTimeout)
- [ ] Full verification chain run in CI order (docs/engineer-workflow.md)
```

## Why this exists

DevPilot's own fail-closed AI generation, retry/backoff, and drift-detection logic are exactly the kind of behavior that's easy to "simplify" into something subtly different — the contract above forces the current behavior to be stated and evidenced before a diff is written, not inferred from the diff afterward.

## Related

[conventions.md](conventions.md) for the test-seam pattern referenced above, [engineer-workflow.md](engineer-workflow.md) for the verification chain, [architecture.md](architecture.md) for the invariants a contract change must not silently break.
