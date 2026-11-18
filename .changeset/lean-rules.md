---
'@knowalabs/meridian': minor
---

`meridian generate` now writes a much smaller rules file. `.meridian/rules.md` — and so `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor's and Copilot's instruction files — is loaded on every agent request, and research on AGENTS.md files found that generated context restating what an agent can discover from the repo itself makes agents slightly less successful and about 20% more expensive. The rules prompt now keeps only what an agent cannot learn in one read of the README, manifests, config or code — traps, the reasons behind non-obvious decisions, forbidden actions, approval boundaries and commands with pitfalls — and drops overviews, framework and config inventories and generic advice. The AI-written body has a budget of about 1,200 tokens: a longer answer is sent back once to be cut, and kept with a warning if it is still over. The static `--no-ai` rules lose their stack, directory and tooling filler the same way.

When `generate` refreshes an existing kit, its resident-cost line now shows the change, e.g. `Kit resident cost: ~3,200 → ~1,400 tokens/request (−56%)`, with a per-part breakdown. Existing kits are only rewritten by a regenerate or `meridian sync` refresh, and hand-edited rules files are preserved as always.
