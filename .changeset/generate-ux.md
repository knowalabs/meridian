---
'@sonalsithara/devpilot': patch
---

Better generate UX: an interactive provider picker appears when several AI providers are available (Enter accepts the recommended one; scripts and pipes auto-route as before), and generation now shows live progress — which files were read, an animated spinner with elapsed time per phase, and per-kind completion lines like "[2/6] Subagents: 3 files (41s)". The claude-code provider now runs asynchronously so the spinner stays alive during CLI calls.
