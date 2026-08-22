# Knowa — Growth & Revenue Plan

_Written 2026-08-08. Private working doc — `business/` is gitignored; this repo is public._

## The bet

Knowa's sellable product is not "set up your AI coding tools." It is:

> **AI coding rules go stale and drift across a team, and nobody notices until an agent
> does something wrong. Knowa detects the drift and fails the build.**

Setup is a one-shot with front-loaded value → no recurring revenue, and the tool vendors
(Anthropic `/init`, Cursor rules) are absorbing it. Drift is continuous, scales with team
size, and is cross-tool — which is the one position Anthropic and Cursor structurally
cannot take, because each only serves its own tool.

`knowa sync --check` already exists. The business is built on that command, not on
`knowa generate`.

**Free CLI = distribution. Paid = org scope (many repos, many people).**

---

## Phase 0 — Ship it (Aug 8 – Aug 22)

Twenty releases, zero users. Nothing below this line matters until the package is
installable. Timebox: two weeks, no new features.

### Blockers

- [ ] **Claim the bare npm name `knowa`** — verified available 2026-08-08. Publish as
      `knowa`, keep `@sonalsithara/knowa` as a deprecated alias pointing at it.
      An unscoped name is worth real money in install-command credibility.
- [ ] **Rename the GitHub repo** `sonal-sithara/devpilot` → `sonal-sithara/knowa`;
      update `git remote set-url origin`. GitHub keeps the redirect.
- [ ] **Fix the README's `Knowa_Docs/` links** (line 187) — the directory is `docs/`.
      Broken link in the first paragraph anyone reads.
- [ ] **Publish 1.0.0**, not 0.20.0. 0.x signals "not ready" to the exact team buyers
      this plan targets. The surface is stable; the version number should say so.
- [ ] **Host `site/index.html`** — Cloudflare Pages on a real domain. Rewrite the hero
      to the drift thesis, not the setup thesis.
- [ ] `SECURITY.md` + `.github/dependabot.yml` (already flagged in CLAUDE.md's
      "Raising the bar"; a security-adjacent tool that ships neither is a bad look).

### Launch

- [ ] Hacker News Show HN, drift framing. Title candidate:
      _"Show HN: Knowa – CI gate that fails the build when your AI coding rules go stale"_
- [ ] r/programming, r/ExperiencedDevs, Claude Code + Cursor Discords, Lobsters.
- [ ] One demo GIF: rules drift → `sync --check` → red CI → `sync` → green. 20 seconds.

**Gate to Phase 1:** package published, install works clean on a fresh machine
(macOS/Windows/Linux), launch posts live.

---

## Phase 1 — Evidence (Aug 22 – Oct 3)

Goal: find out whether the drift thesis is true before building a backend for it.
Do not write server code in this phase.

### Instrument

- [ ] Implement the `telemetry` flag that already exists in `src/core/config.ts:22`.
      Opt-in, prompted on first run, off by default, documented in README + `doctor`.
      Ship only: CLI version, OS, command name, provider id, artifact kinds
      generated/kept/deleted, sync staleness outcome. Never paths, never repo names,
      never content. Keep the collector behind the same `Vault`/`config.ts` boundaries.
- [ ] Add a one-line post-`generate` prompt: "Which of these did you actually keep?"
      — the highest-signal question you can ask, and it costs nothing.

### Talk to ten teams

Not ten individuals. Teams of 5+ engineers. The script:

1. Has a stale/wrong AI rules file ever produced a bad change in your repo?
2. Would you fail a PR on rules drift, or is that too noisy?
3. Who owns "how we use AI tools" standards at your company — is there a name?
4. Do you have a budget line for AI developer tooling this year?
5. How many repos would need this, and how many people touch them?

Question 3 is the real one. If nobody owns it, there's no buyer and the enterprise
path is dead for another year.

### Numbers to hit

| Metric                                          | Target by Oct 3 |
| ----------------------------------------------- | --------------- |
| npm weekly downloads                            | 250             |
| GitHub stars                                    | 400             |
| Repos with `sync --check` in CI (telemetry)     | 25              |
| Team interviews completed                       | 10              |
| Teams saying "yes, I'd pay for the org version" | 3               |

**Kill criteria — be honest here.** If by Oct 3 fewer than 3 teams say drift is a real
pain worth paying for, **do not build the cloud layer**. Pivot instead to whichever
command telemetry says people actually run daily (my guess: `mcp` or `ask`), or
accept Knowa as a portfolio-grade OSS project and stop investing.

---

## Phase 2 — Thinnest paid thing (Oct 6 – Nov 28)

Only if Phase 1's gate passes. Build the smallest product a team will pay for, and
nothing else.

### Scope — three features, no more

1. **Org base rules.** One canonical ruleset defined once, inherited into N repos,
   with per-repo local overrides. This is the killer feature; everything else is
   supporting cast.
2. **Drift dashboard.** One page listing every connected repo and whether its kit is
   fresh, stale, or hand-edited. Read straight from `manifest.json` fingerprints —
   `diffFingerprints`/`fileStates` already compute this.
3. **`knowa login`.** Fill in the stub in `src/commands/update.ts`. Device-code flow,
   token in the existing vault. No new secret-storage code paths.

Explicitly out of scope for v1: SSO, RBAC, self-hosting, audit log, web-based rule
editing, Slack/Jira integrations, a marketplace.

### Open-core boundary — decide before writing code

MIT code cannot be clawed back. Draw the line once, at **single-repo vs. org scope**:

| Free forever (MIT, this repo)                                         | Paid (private service + `@knowa/cloud` client)  |
| --------------------------------------------------------------------- | ----------------------------------------------- |
| `doctor`, `install`, `auth`, `keys`, `mcp`, `ask`, `router`, `update` | Org base rules → inherited into N repos         |
| `generate` + `sync` for one repo, unlimited                           | Cross-repo drift dashboard                      |
| Local vault, local `manifest.json`, CI gate                           | Shared/versioned team kits                      |
| Every artifact kind, every provider                                   | SSO, audit log, policy enforcement, self-hosted |

The free CLI stays genuinely unrestricted — no repo caps, no artifact caps, no nag.
It is the funnel, and crippling it kills distribution to save revenue you don't have yet.

Architecturally: cloud lives in a **separate private repo**, talks to the OSS CLI over
a stable interface, and the OSS CLI keeps working fully offline with zero cloud
awareness beyond `login`. Per CLAUDE.md, nothing may assume non-local state until
this ships.

### Pricing

| Tier       | Price                  | For                                         |
| ---------- | ---------------------- | ------------------------------------------- |
| Free       | $0                     | Individuals, OSS, single repo. Unlimited.   |
| Team       | $19/dev/month          | Org rules, drift dashboard, up to 50 repos  |
| Enterprise | Custom (start $15k/yr) | SSO, audit, policy enforcement, self-hosted |

Seat-based, because drift pain scales with headcount. Annual only for Enterprise.

**Gate to Phase 3:** 5 paying teams, ~$5k ARR. That is the proof; revenue amount
is irrelevant at this stage.

---

## Phase 3 — Governance (Dec 2026 +)

Only with Phase 2 revenue. The reframe that unlocks real budget:

> The generated `.claude/settings.json` is an **AI agent permission policy**.
> Enterprise Knowa enforces, versions, and audits it across every repo in the org.

"Which commands are our AI agents allowed to run, enforced org-wide, with an audit
trail" is a security/compliance purchase with an existing budget line. "Config
generator" is not. This is the same code you already ship — the `harness` artifact
kind — sold to a different buyer.

Enterprise-only: policy inheritance that repos cannot override, violation alerts,
SSO/SCIM, self-hosted deployment, SOC 2 (start the process here, not earlier).

---

## Bridge revenue — consulting (runs alongside, from Sept)

Fastest path to a first real dollar, and every engagement is a paid customer interview.

- **"AI-readiness audit"** for 20–100 engineer orgs: 1–2 weeks, delivered _using_
  Knowa, priced $8–15k. Deliverable is their kit + a standards doc + a rollout plan.
- Two or three of these fund six months of building, and each one tells you exactly
  what Phase 2 should contain.

This is a bridge, not the business. Cap it at ~30% of your time or the product stalls.

---

## What I am explicitly not doing

- Not building the cloud backend before Phase 1's gate passes.
- Not adding new artifact kinds, providers, or CLI features during Phase 0.
- Not restricting the free CLI to drive upgrades.
- Not chasing individual-developer subscriptions — devs don't pay for setup tools.
- Not competing with Anthropic/Cursor on single-tool depth. Neutrality is the moat.

---

## The one-line summary

The next commit that matters is `npm publish`. Everything after that is a response
to evidence you don't have yet.
