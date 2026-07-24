---
'@sonalsithara/devpilot': minor
---

`devpilot generate` is now AI-first: it refuses to run without a configured provider (offline templates require an explicit `--no-ai`), and before generating anything the AI reads the codebase digest and writes a full codebase review — saved to `.devpilot/docs/codebase-review.md` — which grounds every generated file. Language detection now covers Vue, Svelte, Astro, Dart, Elixir, Scala, HTML/CSS and more, and framework detection recognizes Flutter, Angular, Tailwind, Vite, Maven, Gradle, Composer and Bundler projects.
