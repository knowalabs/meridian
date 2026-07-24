import path from 'node:path';
import { ProjectAnalysis, renderArchitectureMarkdown } from '../scan/analyzer.js';

/**
 * Artifact kinds for `devpilot generate`: everything a developer would
 * otherwise hand-write to make a project AI-ready — rules, subagents, skills,
 * slash commands, reusable prompts and docs. Each kind knows how to prompt an
 * AI provider for project-tailored content and how to fall back to a rich
 * static version derived from the codebase analysis when no provider is
 * available.
 */

export interface ArtifactFile {
  /** Project-relative POSIX path. */
  file: string;
  content: string;
}

export interface ArtifactKind {
  id: string;
  name: string;
  description: string;
  /** Path prefixes (or exact files) the AI is allowed to write for this kind. */
  allowedPaths: string[];
  /** Derived files rewritten on every run (they mirror the code). */
  alwaysOverwrite?: string[];
  prompt(digest: string): string;
  fallback(analysis: ProjectAnalysis): ArtifactFile[];
}

/* --------------------------- multi-file protocol --------------------------- */

const FORMAT_SPEC = `Respond with one or more file blocks and NOTHING else — no prose before,
between or after blocks. Each block is:

<<<FILE relative/path/to/file.md>>>
(file content)
<<<END>>>

Paths must be relative to the project root. Markdown content goes inside the
block as-is (do not wrap it in code fences).`;

/** Parse the `<<<FILE p>>> … <<<END>>>` protocol; tolerant of stray fences. */
export function parseFileBlocks(response: string): ArtifactFile[] {
  const files: ArtifactFile[] = [];
  const re = /<<<FILE\s+([^>]+?)\s*>>>\r?\n([\s\S]*?)\r?\n?<<<END>>>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(response)) !== null) {
    const file = match[1]!.trim();
    let content = match[2]!;
    // Models sometimes wrap block content in a markdown fence — unwrap it.
    const fenced = /^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/.exec(content.trim());
    if (fenced) content = fenced[1]!;
    if (file) files.push({ file, content: content.replace(/\s+$/, '') + '\n' });
  }
  return files;
}

/**
 * True when `file` is a safe relative path inside one of the allowed
 * prefixes. Blocks absolute paths, drive letters and `..` escapes.
 */
export function isAllowedPath(file: string, allowed: string[]): boolean {
  if (path.isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file)) return false;
  const normal = path.posix.normalize(file.replace(/\\/g, '/'));
  if (normal.startsWith('..') || normal.includes('/../')) return false;
  return allowed.some((p) => (p.endsWith('/') ? normal.startsWith(p) : normal === p));
}

/* --------------------------------- helpers --------------------------------- */

/** Resolve a canonical script name to the command a developer actually runs. */
const commandFor = (a: ProjectAnalysis, name: string): string =>
  a.scriptRunner ? `${a.scriptRunner}${name}` : (a.scripts[name] ?? name);

function stack(a: ProjectAnalysis): string {
  const langs = a.languages.map((l) => l.language).join(', ') || 'unknown language';
  return a.frameworks.length ? `${langs} with ${a.frameworks.join(', ')}` : langs;
}

/** Top-level directories parsed out of the rendered tree. */
function topLevelDirs(a: ProjectAnalysis): string[] {
  return a.tree
    .split('\n')
    .filter((line) => /^(├── |└── ).*\/$/.test(line))
    .map((line) => line.replace(/^(├── |└── )/, '').replace(/\/$/, ''));
}

/** Scripts worth turning into workflows, in a stable, useful order. */
function workflowScripts(a: ProjectAnalysis): [string, string][] {
  const interesting = /^(test|lint|build|format|typecheck|check|dev|start|e2e|coverage)/;
  return Object.entries(a.scripts)
    .filter(([name]) => interesting.test(name))
    .slice(0, 8);
}

function verificationChecklist(a: ProjectAnalysis): string[] {
  const order = ['format', 'lint', 'typecheck', 'build', 'test'];
  return Object.keys(a.scripts)
    .filter((s) => order.some((o) => s === o || s.startsWith(o + ':')))
    .sort(
      (x, y) => order.findIndex((o) => x.startsWith(o)) - order.findIndex((o) => y.startsWith(o)),
    )
    .map((s) => commandFor(a, s));
}

function commonPrompt(kindInstructions: string, digest: string): string {
  return `You are DevPilot, a tool that makes codebases AI-assistant-ready.
First review the project digest below carefully — the layout, the real
frameworks, scripts, dependencies, conventions and the actual source code
excerpts. Then generate the requested files.

Quality bar:
- Be specific to THIS project: reference its real directories, modules,
  scripts and configuration by name. Generic advice that would fit any
  project is a failure.
- Never invent files, scripts, commands or dependencies not shown in the
  digest.
- Content should be thorough and immediately useful — a developer should not
  need to edit it afterwards. Depth beats brevity; cover the edge cases you
  can see in the code.

${kindInstructions}

${FORMAT_SPEC}

--- PROJECT DIGEST ---
${digest}`;
}

/* ---------------------------------- kinds ---------------------------------- */

export const ARTIFACT_KINDS: ArtifactKind[] = [
  {
    id: 'rules',
    name: 'Rules',
    description: 'canonical project rules (.devpilot/rules.md → all tools)',
    allowedPaths: ['.devpilot/rules.md'],
    prompt: (digest) =>
      commonPrompt(
        `Generate exactly one file: ".devpilot/rules.md" — the canonical coding
rules for AI assistants working in this repository. Structure it as:

## General — how to approach changes in this codebase
## Architecture — what each top-level directory/module is for and the
   boundaries an AI must respect (derive from the layout and source excerpts)
## Code Style — the project's real idioms: naming, error handling, imports,
  formatting tools, patterns visible in the source excerpts
## Testing — which test frameworks/configs exist, where tests live, what a
  change must include, exact commands to run
## Verification — the exact ordered commands to run before work is done
## Safety — secrets, destructive operations, files never to touch

Every rule is an imperative one-liner an AI can follow. Aim for 60–120 lines
of genuinely project-specific rules.`,
        digest,
      ),
    fallback: (a) => {
      const dirs = topLevelDirs(a);
      const checklist = verificationChecklist(a);
      const testScripts = Object.keys(a.scripts).filter((s) => s.startsWith('test'));
      return [
        {
          file: '.devpilot/rules.md',
          content: `## General

- Read \`.devpilot/context.md\` and \`docs/architecture.md\` before making changes.
- Keep changes small and focused; follow existing patterns in the codebase.
- Write or update tests alongside every behavior change.
- Update documentation when behavior changes.

## Architecture

- Stack: ${stack(a)}.
${dirs.map((d) => `- \`${d}/\` — keep changes scoped here when working on this area; do not create new top-level directories without need.`).join('\n') || '- Single-directory project — keep the flat layout.'}

## Code Style

- Match the project's existing formatting, naming and idioms.
${a.conventions.map((c) => `- Respect the configured tooling: ${c}.`).join('\n')}
- Prefer clear, self-explanatory code over comments.

## Testing

${
  testScripts.length
    ? testScripts
        .map(
          (s) =>
            `- Run tests with \`${commandFor(a, s)}\`; add tests next to the existing ones for any new behavior.`,
        )
        .join('\n')
    : '- No test script detected — add tests when introducing a test framework.'
}

## Verification

${checklist.length ? `Run, in order, before considering any work done:\n\n${checklist.map((c, i) => `${i + 1}. \`${c}\``).join('\n')}` : '- Build/verify manually; no scripts detected.'}

## Safety

- Never commit secrets, API keys or credentials.
- Ask before running destructive commands (deletes, force-pushes, migrations).
- Never edit generated files by hand (\`dist/\`, coverage output, lockfiles except via the package manager).
`,
        },
      ];
    },
  },
  {
    id: 'agents',
    name: 'Subagents',
    description: 'Claude Code subagents (.claude/agents/)',
    allowedPaths: ['.claude/agents/'],
    prompt: (digest) =>
      commonPrompt(
        `Generate 3–4 Claude Code subagent files under ".claude/agents/", each a
specialist for THIS project — for example: a code reviewer with a checklist
built from the project's real conventions and past-bug-prone areas visible in
the code; a test runner/fixer that knows the exact test commands and layout;
a domain specialist for the project's core subsystem (name it); a refactoring
guide that knows the module boundaries. Each file needs YAML frontmatter:

---
name: kebab-case-name
description: When this agent should be used (one sentence, third person).
---

followed by a detailed system prompt in markdown: the agent's role, what it
knows about this project (real paths, commands, patterns), its step-by-step
working procedure, and its output format. Make each agent 30–60 lines.`,
        digest,
      ),
    fallback: (a) => {
      const dirs = topLevelDirs(a);
      const checklist = verificationChecklist(a);
      return [
        {
          file: '.claude/agents/code-reviewer.md',
          content: `---
name: code-reviewer
description: Reviews changes for bugs, style and convention violations before commit.
---

You review code changes in ${a.name} (${stack(a)}).

Checklist, in order:
1. Correctness — logic errors, unhandled edge cases, broken error handling.
2. Tests — every behavior change has a matching test; tests assert behavior,
   not implementation details.
3. Conventions — changes follow .devpilot/rules.md${a.conventions.length ? ` and the configured tooling (${a.conventions.join(', ')})` : ''}.
4. Scope — the diff stays inside the module boundaries${dirs.length ? ` (${dirs.map((d) => `\`${d}/\``).join(', ')})` : ''}; no drive-by refactors.
5. Safety — no secrets, credentials or generated files in the diff.

Report findings by file and line, most severe first. For each: what is wrong,
why it matters, and the smallest fix. End with a verdict: approve / request changes.
`,
        },
        {
          file: '.claude/agents/test-fixer.md',
          content: `---
name: test-fixer
description: Runs the test suite and fixes failures without changing intended behavior.
---

You fix failing tests in ${a.name}.

Procedure:
1. ${a.scripts['test'] ? `Run \`${commandFor(a, 'test')}\` and read the failure output carefully.` : 'Locate and run the test suite.'}
2. Reproduce the smallest failing case; identify whether the bug is in the
   code under test or the test itself.
3. Apply the smallest fix that restores intended behavior.
4. Re-run until green${checklist.length ? `, then run the full verification chain: ${checklist.map((c) => `\`${c}\``).join(' → ')}` : ''}.

Never delete, skip or weaken a test to make it pass. If a test asserts
outdated behavior, say so explicitly and update the assertion with the reason.
`,
        },
        {
          file: '.claude/agents/architect.md',
          content: `---
name: architect
description: Plans multi-file changes so they respect the project's module boundaries.
---

You plan implementation strategies for ${a.name} (${stack(a)}).

Given a feature or fix request:
1. Read docs/architecture.md and the modules involved${dirs.length ? ` (top-level: ${dirs.map((d) => `\`${d}/\``).join(', ')})` : ''}.
2. Produce a step-by-step plan: files to create/modify in order, what each
   change contains, and which existing patterns to reuse.
3. Flag anything that would cross a module boundary or need a new dependency —
   those need explicit sign-off.
4. End with the verification commands to run when the plan is implemented.
`,
        },
      ];
    },
  },
  {
    id: 'skills',
    name: 'Skills',
    description: 'Claude Code skills (.claude/skills/)',
    allowedPaths: ['.claude/skills/'],
    prompt: (digest) =>
      commonPrompt(
        `Generate 2–3 Claude Code skills under ".claude/skills/<skill-name>/SKILL.md",
each capturing a repeatable, project-specific workflow an AI assistant should
follow here — e.g. how to add a feature end-to-end in this architecture
(which files, in which order, with which patterns), how to run/debug this
project locally, how to release/ship. Each SKILL.md needs YAML frontmatter:

---
name: kebab-case-name
description: One sentence saying when to use this skill.
---

followed by concrete numbered steps referencing real paths, modules and
commands from the digest. 25–60 lines each; every step actionable.`,
        digest,
      ),
    fallback: (a) => {
      const dirs = topLevelDirs(a);
      const srcDir = dirs.find((d) => ['src', 'lib', 'app'].includes(d));
      const testDir = dirs.find((d) => ['tests', 'test', '__tests__', 'spec'].includes(d));
      const checklist = verificationChecklist(a);
      return [
        {
          file: '.claude/skills/project-conventions/SKILL.md',
          content: `---
name: project-conventions
description: Follow ${a.name}'s conventions when writing or reviewing code.
---

# ${a.name} conventions

- Stack: ${stack(a)}.
${a.conventions.map((c) => `- ${c}`).join('\n') || '- See .devpilot/context.md.'}

Before large changes, read \`.devpilot/rules.md\` and \`.devpilot/context.md\`.
${checklist.length ? `\nVerification, in order: ${checklist.map((c) => `\`${c}\``).join(' → ')}` : ''}
`,
        },
        {
          file: '.claude/skills/add-feature/SKILL.md',
          content: `---
name: add-feature
description: Add a feature to ${a.name} end-to-end, from code to passing verification.
---

# Adding a feature to ${a.name}

1. Read \`docs/architecture.md\` and the module you are changing${srcDir ? ` (source lives in \`${srcDir}/\`)` : ''}.
2. Find the closest existing feature and mirror its structure — file
   placement, naming, error handling, exports.
3. Implement the smallest complete version of the feature.
${testDir ? `4. Add tests in \`${testDir}/\`, mirroring the existing test style.` : `4. Add tests next to the existing ones, mirroring their style.`}
5. Update docs (README or docs/) if behavior is user-visible.
${checklist.length ? `6. Verify, in order: ${checklist.map((c) => `\`${c}\``).join(' → ')}.` : `6. Run the project's build/tests to verify.`}
`,
        },
      ];
    },
  },
  {
    id: 'commands',
    name: 'Slash commands',
    description: 'Claude Code slash commands (.claude/commands/)',
    allowedPaths: ['.claude/commands/'],
    prompt: (digest) =>
      commonPrompt(
        `Generate 4–7 Claude Code slash-command files under ".claude/commands/".
Each file is a markdown prompt the developer invokes as /<filename>; use
$ARGUMENTS where the user's input belongs. Cover this project's real
workflows: the verify/fix loop with its actual scripts, reviewing a diff
against the project's conventions, scaffolding a new module/feature the way
this architecture does it, releasing if the digest shows a release process,
debugging the running app. Start each file with YAML frontmatter containing a
one-line description. Each command's body should give the AI enough
project-specific instruction to execute well (5–20 lines).`,
        digest,
      ),
    fallback: (a) => {
      const files: ArtifactFile[] = [];
      const add = (name: string, description: string, body: string) =>
        files.push({
          file: `.claude/commands/${name}.md`,
          content: `---\ndescription: ${description}\n---\n\n${body}\n`,
        });
      for (const [script] of workflowScripts(a)) {
        const cmdName = script.replace(/[:.]/g, '-');
        add(
          cmdName,
          `Run ${commandFor(a, script)} and fix anything it reports`,
          `Run \`${commandFor(a, script)}\`. If it fails, diagnose the root cause and fix it — never by weakening tests or silencing checks — then re-run until it passes.`,
        );
      }
      add(
        'verify',
        'Run the full verification chain and fix failures',
        verificationChecklist(a).length
          ? `Run, in order: ${verificationChecklist(a)
              .map((c) => `\`${c}\``)
              .join(
                ' → ',
              )}. Fix every failure at the root cause and re-run the chain until it is fully green. Summarize what was fixed.`
          : `Build and test the project; fix every failure at the root cause and re-run until green.`,
      );
      add(
        'review',
        'Review the current diff against project conventions',
        `Review the uncommitted diff in ${a.name} against .devpilot/rules.md: correctness, tests, conventions, scope, secrets. Report by file and line, most severe first.`,
      );
      add(
        'explain',
        'Explain how a part of this codebase works',
        `Explain how $ARGUMENTS works in ${a.name}. Read the relevant source first; cite files and line numbers; include a short call-flow if useful.`,
      );
      return files;
    },
  },
  {
    id: 'prompts',
    name: 'Prompts',
    description: 'reusable prompt library (.devpilot/prompts/)',
    allowedPaths: ['.devpilot/prompts/'],
    prompt: (digest) =>
      commonPrompt(
        `Generate 3–4 reusable prompt files under ".devpilot/prompts/" that a
developer on this project will actually reach for — e.g. reviewing a PR in
this stack, implementing a new module following this architecture, debugging
this runtime, writing tests in this project's style. Plain markdown, each
starting with a "# Title" line, followed by a ready-to-paste prompt that
bakes in the project's real context (stack, paths, commands, conventions).`,
        digest,
      ),
    fallback: (a) => {
      const checklist = verificationChecklist(a);
      return [
        {
          file: '.devpilot/prompts/review.md',
          content: `# Review a change

Review the current diff in ${a.name} (${stack(a)}) for:
1. Correctness — logic errors and unhandled edge cases.
2. Tests — behavior changes without matching tests.
3. Conventions — violations of .devpilot/rules.md.
4. Security — secrets, injection, unsafe file/network handling.

Report by file and line, most severe first, with the smallest fix for each.
`,
        },
        {
          file: '.devpilot/prompts/new-module.md',
          content: `# Implement a new module

Implement <module> in ${a.name} (${stack(a)}). Before writing code, read
docs/architecture.md and the closest existing module, then mirror its
structure, naming and error handling. Include tests in the existing style${
            checklist.length
              ? ` and finish by running: ${checklist.map((c) => `\`${c}\``).join(' → ')}`
              : ''
          }.
`,
        },
        {
          file: '.devpilot/prompts/debug.md',
          content: `# Debug an issue

Debug this issue in ${a.name}: <describe the symptom>. Reproduce it first,
trace the actual code path (cite files/lines), state the root cause in one
sentence, then apply the smallest fix and prove it with a test.
`,
        },
      ];
    },
  },
  {
    id: 'docs',
    name: 'Docs',
    description: 'professional docs suite (docs/)',
    allowedPaths: ['docs/'],
    prompt: (digest) =>
      commonPrompt(
        `Generate a professional engineering documentation suite under "docs/" —
the documents a staff engineer would hand a new teammate on THIS project.

Always generate these seven core docs:

1. "docs/README.md" — the index: a table listing every doc you generated
   with a one-line "read this when…" for each.
2. "docs/architecture.md" — the layers/modules and their responsibilities
   (name the real directories and key files), how control/data flows
   between them, external dependencies and why each exists, and the
   invariants a change must not break.
3. "docs/conventions.md" — the project's real conventions: naming, file
   organization, imports, typing, error handling, formatting/lint tooling
   and its configuration. Prove every convention with a reference to a
   file in the digest that shows it.
4. "docs/engineer-workflow.md" — day-one setup, everyday commands (dev,
   test, lint, build — the real scripts), the exact ordered verification
   to run before work is considered done, and the release/CI process when
   the digest shows one.
5. "docs/security.md" — how secrets and configuration are handled, input
   validation, authentication/authorization if present, files that must
   never be committed, and the code paths to treat with extra care.
6. "docs/tech-debt.md" — an honest register of debt visible in the digest:
   TODO/FIXME markers, duplicated logic, missing tests, deprecated usage.
   Use a table: area | description | impact | suggested fix. If little
   debt is visible, say so and keep the register short.
7. "docs/BEHAVIOUR_CONTRACT_TEMPLATE.md" — a reusable fill-in template for
   specifying a feature's observable behavior before changing it: context,
   triggers, preconditions, expected behavior, edge cases, error handling,
   non-goals, and how to verify.

Then generate ONLY the specialized docs below that the digest shows real
evidence for. Skipping one is correct when the project has nothing to
document — never write a generic filler version:

- "docs/design-system.md" — if there are UI components, design tokens or
  theming. When the project has many components, split them across
  "docs/design-system-core-components.md",
  "docs/design-system-feature-components.md" and
  "docs/design-system-input-components.md".
- "docs/di-registry.md" — if dependency injection is used: every
  registration, its scope/lifetime, and where it is resolved.
- "docs/localization.md" — if i18n/l10n exists: the framework, where
  locale files live, and how to add a string or a new locale.
- "docs/navigation.md" — if the app has routing/navigation: the route
  map, guards/middleware, deep links, and how to add a screen or route.
- "docs/networking.md" — if there is an HTTP/API client layer: clients,
  base URLs, auth, error/retry/timeout handling, how to add an endpoint.
- "docs/shared-utilities.md" — if shared helper/util modules exist: each
  utility, what it does, and when to use it instead of writing new code.

Each doc you write should be 40–120 lines and dense with THIS project's
real paths, names and commands.`,
        digest,
      ),
    fallback: (a) => {
      const scripts = workflowScripts(a);
      const checklist = verificationChecklist(a);
      return [
        {
          file: 'docs/README.md',
          content: `# ${a.name} — documentation

| Doc | Read this when… |
| --- | --- |
| [architecture.md](architecture.md) | you need the module map and how data flows between them |
| [conventions.md](conventions.md) | you are writing code and want it to match the codebase |
| [engineer-workflow.md](engineer-workflow.md) | you are setting up, running or verifying the project |
| [tech-debt.md](tech-debt.md) | you want to know the known rough edges before touching them |
| [BEHAVIOUR_CONTRACT_TEMPLATE.md](BEHAVIOUR_CONTRACT_TEMPLATE.md) | you are specifying a feature's behavior before changing it |

Generated by \`devpilot generate\`. Re-run with an AI provider and \`--force\`
for docs written from an actual reading of the codebase.
`,
        },
        {
          file: 'docs/architecture.md',
          content: renderArchitectureMarkdown(a),
        },
        {
          file: 'docs/conventions.md',
          content: `# ${a.name} — conventions

## Stack

- ${stack(a)}.
- ${a.totalFiles} files; primary languages: ${a.languages.map((l) => `${l.language} (${l.files})`).join(', ') || 'unknown'}.

## Tooling

${a.conventions.map((c) => `- ${c}`).join('\n') || '- No formatter/linter configs detected — match the style of the surrounding code.'}

## Ground rules

- Match the existing formatting, naming and idioms of the file you are in.
- Mirror the closest existing module when adding a new one — placement,
  naming, error handling, exports.
- Prefer clear, self-explanatory code over comments.
`,
        },
        {
          file: 'docs/engineer-workflow.md',
          content: `# ${a.name} — engineer workflow

## Everyday commands

${scripts.length ? scripts.map(([name, cmd]) => `- \`${commandFor(a, name)}\`${a.scriptRunner ? ` — \`${cmd}\`` : ''}`).join('\n') : '- No scripts detected — build and run manually.'}

## Verification

${checklist.length ? `Run, in order, before considering any work done:\n\n${checklist.map((c, i) => `${i + 1}. \`${c}\``).join('\n')}` : 'Build and test the project manually; no verification scripts detected.'}

## Where things live

\`\`\`
${a.tree}
\`\`\`
`,
        },
        {
          file: 'docs/tech-debt.md',
          content: `# ${a.name} — tech debt register

Track known debt here so it is paid down deliberately instead of
rediscovered. Add a row when you find or knowingly introduce debt.

| Area | Description | Impact | Suggested fix |
| --- | --- | --- | --- |
| _(none recorded yet)_ | | | |
`,
        },
        {
          file: 'docs/BEHAVIOUR_CONTRACT_TEMPLATE.md',
          content: `# Behaviour contract — <feature name>

Fill this in before changing a feature's observable behavior; it is the
agreed contract the change is verified against.

## Context

<What part of the system this covers and why it exists.>

## Triggers

<User actions, events or inputs that start this behavior.>

## Preconditions

<State that must hold before the behavior runs.>

## Expected behavior

<The observable outcome, step by step. Be precise enough to test.>

## Edge cases

<Empty input, concurrency, offline, permissions, limits — and what happens.>

## Error handling

<What the user sees and what the system does on each failure mode.>

## Non-goals

<Adjacent behavior this contract deliberately does not cover.>

## Verification

<The exact commands/tests that prove the contract holds.>
`,
        },
      ];
    },
  },
];

export function kindsById(ids: string[]): ArtifactKind[] {
  return ids.length ? ARTIFACT_KINDS.filter((k) => ids.includes(k.id)) : ARTIFACT_KINDS;
}
