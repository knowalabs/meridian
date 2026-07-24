---
'@sonalsithara/devpilot': patch
---

Generate runs are now resumable: if the provider fails mid-run (e.g. a Claude subscription's 5-hour usage window runs out), DevPilot keeps every AI-generated file, writes nothing for the failed kinds instead of silently downgrading them to generic templates, detects limit/quota errors and stops early, and exits 1 with guidance. Re-running later continues where it left off; `--provider` finishes immediately with another provider. Empty AI responses get one retry.
