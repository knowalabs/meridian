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
  /** Minimum files a well-formed AI response contains (default 1). */
  minFiles?: number;
  /** Exact paths a well-formed AI response must include. */
  requiredFiles?: string[];
  /** Only generated when explicitly requested by id, never as part of "all". */
  optIn?: boolean;
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
export function topLevelDirs(a: ProjectAnalysis): string[] {
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

/** Heuristic: does the project have a user interface layer? */
const hasUiLayer = (a: ProjectAnalysis): boolean =>
  a.frameworks.some((f) => /react|next|vue|svelte|angular|astro|flutter|electron/i.test(f)) ||
  a.languages.some((l) => /\(react\)|vue|svelte|astro|dart|swift/i.test(l.language));

/** Heuristic: does the project have an API/route layer? */
const hasApiLayer = (a: ProjectAnalysis): boolean =>
  a.apiRoutes.length > 0 || a.frameworks.some((f) => /express|fastify|nestjs/i.test(f));

function verificationChecklist(a: ProjectAnalysis): string[] {
  const order = ['format', 'lint', 'typecheck', 'build', 'test'];
  return Object.keys(a.scripts)
    .filter((s) => order.some((o) => s === o || s.startsWith(o + ':')))
    .sort(
      (x, y) => order.findIndex((o) => x.startsWith(o)) - order.findIndex((o) => y.startsWith(o)),
    )
    .map((s) => commandFor(a, s));
}

/**
 * Gaps between the project as scanned and a professional/enterprise
 * baseline, each phrased as the concrete adoption step that closes it.
 * Language-agnostic: derived from the ecosystem-detected scripts and
 * conventions, not from any single stack's tooling.
 */
function raisingTheBar(a: ProjectAnalysis): string[] {
  const gaps: string[] = [];
  const hasScript = (name: string) => Object.keys(a.scripts).some((s) => s.startsWith(name));
  if (!hasScript('test'))
    gaps.push(
      'Adopt an automated test suite wired to a single `test` command — new behavior must not land unverified.',
    );
  if (!hasScript('lint') && !a.conventions.some((c) => /lint/i.test(c)))
    gaps.push(
      "Adopt a linter for the project's primary language and fix its findings incrementally.",
    );
  if (!hasScript('format') && !a.conventions.some((c) => /format|prettier/i.test(c)))
    gaps.push('Adopt an auto-formatter so style stays uniform as contributors join.');
  if (!a.conventions.some((c) => /\bci\b|workflow|jenkins|circleci|pipeline/i.test(c)))
    gaps.push('Add a CI pipeline that runs the full verification chain on every push.');
  return gaps;
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
  digest. The digest is your single source of truth; file excerpts may be
  truncated — describe only what you can actually see.
- Cover the core concepts: the digest's Code map lists every class,
  function and type in the project, including files whose contents are not
  excerpted. Name and account for the load-bearing ones — an artifact that
  ignores the real domain model (its key classes, central functions, data
  structures) is a failure.
- Content should be thorough and immediately useful — a developer should not
  need to edit it afterwards. Depth beats brevity; cover the edge cases you
  can see in the code.
- The generated files ARE this repository's engineering standard, whatever
  the language. Encode the professional, enterprise-grade practices of this
  stack's own ecosystem — error handling, input validation, security,
  test discipline, dependency hygiene — as concrete rules grounded in the
  code you can see, so every future change is held to that bar.
- Write for where the project is going, not only where it is: use the
  maturity gaps and trajectory from the codebase review so the kit keeps
  the code professional as it grows. When you recommend a practice or tool
  the project does not have yet, mark it explicitly as an adoption step —
  never present an unverified command or file as already existing.
- Write rules and steps as imperatives; no filler sentences, no hedging.
- Any workflow step that is destructive or hard to reverse — committing,
  pushing, tagging, publishing, deleting, migrating — must be gated on
  explicit user approval: the workflow shows exactly what it is about to do
  and waits for the user's reply before doing it. Suspected secrets or
  sensitive data are a hard stop with no "continue anyway" option. Never
  generate a workflow that amends or force-pushes.

${kindInstructions}

Final self-check before responding: every path, script, command and
dependency you mention must appear in the digest — remove any that do not,
and confirm you produced every file the instructions require.

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
    requiredFiles: ['.devpilot/rules.md'],
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
## Raising the bar — the standards this project should adopt next to reach
   enterprise quality, taken from the maturity gaps and trajectory in your
   codebase review. Each is an imperative with its concrete first step, and
   each is clearly an adoption step — never disguised as something the
   project already has.

Every rule is an imperative one-liner an AI can follow. Aim for 60–140 lines
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

## Raising the bar

${
  raisingTheBar(a)
    .map((g) => `- ${g}`)
    .join('\n') ||
  '- Tooling baseline is solid — keep tests, lint, formatting and CI green as the project grows.'
}
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
    minFiles: 3,
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
    minFiles: 4,
    requiredFiles: ['.claude/skills/commit/SKILL.md'],
    prompt: (digest) =>
      commonPrompt(
        `Generate 4–8 Claude Code skills, each at
".claude/skills/<skill-name>/SKILL.md", capturing THIS project's actual
repeatable workflows. Derive the set from the codebase itself — its
architecture, layers and everyday engineering tasks — and name each skill
in the project's own vocabulary.

One skill is required in every project: ".claude/skills/commit/SKILL.md" —
committing is a universal workflow, but its content must be as
project-specific as the rest: the exact ordered verification chain to run
before committing, the repository's real commit-message conventions, and
what must never be staged here. A generic five-liner is a failure.
The commit skill is INTERACTIVE — it must be structured as ordered steps
that each stop for the user:
1. Inspect what is staged (git status/diff --cached) and summarize it;
   stop if nothing is staged. Unstaged changes are not part of the commit.
2. Scan the staged diff for secrets/credentials/keys (hard stop, no
   override), plus this project's own red flags visible in the digest —
   debug output, generated files staged without their sources, leftover
   TODOs — and ask the user whether to continue when found.
3. Propose the full commit message in this repository's real convention
   and wait for the user to approve, edit or cancel before committing.
4. Only commit after approval; never amend, never stage extra files the
   user did not approve.
5. Ask before any push; never force-push.

Illustrative examples of the other kinds of skills a project might warrant
(pick, rename, replace or invent as the digest dictates — none are
required): "new-feature", "fix-bug", "refactor", "feature-info",
"new-utility", "implement-api" for a project with an API layer,
"new-screen" for a UI app, or fully domain-specific ones — a CLI tool
might want "new-command", a library "new-public-api", a project with a
release process "release", one with schema migrations "new-migration".

Two hard rules: never generate a skill for a workflow this project does
not have, and prefer a skill grounded in the digest's real structure over
a generic one from the list above.

Each SKILL.md needs YAML frontmatter:

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
      const verify = checklist.length
        ? `Verify, in order: ${checklist.map((c) => `\`${c}\``).join(' → ')}.`
        : `Run the project's build/tests to verify.`;
      const skill = (name: string, description: string, body: string): ArtifactFile => ({
        file: `.claude/skills/${name}/SKILL.md`,
        content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
      });
      const files: ArtifactFile[] = [
        skill(
          'new-feature',
          `Add a feature to ${a.name} end-to-end, from code to passing verification.`,
          `# Adding a feature to ${a.name}

1. Read \`docs/architecture.md\` and the module you are changing${srcDir ? ` (source lives in \`${srcDir}/\`)` : ''}.
2. Find the closest existing feature and mirror its structure — file
   placement, naming, error handling, exports.
3. Implement the smallest complete version of the feature.
${testDir ? `4. Add tests in \`${testDir}/\`, mirroring the existing test style.` : `4. Add tests next to the existing ones, mirroring their style.`}
5. Update docs (README or docs/) if behavior is user-visible.
6. ${verify}`,
        ),
        skill(
          'fix-bug',
          `Fix a bug in ${a.name} at the root cause, proven by a regression test.`,
          `# Fixing a bug in ${a.name}

1. Reproduce the bug first${a.scripts['test'] ? ` — ideally as a failing test (\`${commandFor(a, 'test')}\`)` : ''}.
   No fix before a reproduction.
2. Trace the actual code path from the symptom to the cause; cite the
   files and lines involved.
3. State the root cause in one sentence, then apply the smallest fix at
   that cause — not a workaround where the symptom appears.
4. Keep the reproduction as a regression test, asserting the intended
   behavior rather than implementation details.
5. ${verify}`,
        ),
        skill(
          'refactor',
          `Refactor ${a.name} without changing behavior, in small verified steps.`,
          `# Refactoring ${a.name}

1. Confirm the tests are green before touching anything${a.scripts['test'] ? ` (\`${commandFor(a, 'test')}\`)` : ''}.
2. Read \`docs/architecture.md\`; the module boundaries${dirs.length ? ` (${dirs.map((d) => `\`${d}/\``).join(', ')})` : ''} must
   still hold after the refactor.
3. Move in small steps — rename, extract, inline — running the tests
   between steps; never mix a refactor with a behavior change.
4. Keep the public API stable unless the change is the point; update every
   caller in the same change.
5. ${verify}`,
        ),
        skill(
          'feature-info',
          `Investigate and explain how an existing feature of ${a.name} works.`,
          `# Explaining a feature of ${a.name}

1. Locate the entry point: search${srcDir ? ` \`${srcDir}/\`` : ' the source'} for the feature's
   name, command, route or UI text.
2. Trace the flow outward from the entry point, noting each file (and
   line) the control or data passes through.
3. Read the feature's tests${testDir ? ` in \`${testDir}/\`` : ''} — they document the intended behavior
   and edge cases.
4. Report: what the feature does, the flow as a file-by-file list, key
   data structures, edge cases covered, and where to change what.`,
        ),
        skill(
          'new-utility',
          `Add a shared utility/helper to ${a.name} without duplicating an existing one.`,
          `# Adding a utility to ${a.name}

1. Search the codebase for an existing helper first — a duplicated utility
   is a bug. Grep for likely names and read the neighbors.
2. Place it next to similar helpers${srcDir ? ` under \`${srcDir}/\`` : ''}, following the local naming
   and export style.
3. Keep it small and single-purpose; no side effects unless that is the
   point.
4. Add focused tests for the edge cases (empty input, errors, limits).
5. ${verify}`,
        ),
        skill(
          'commit',
          `Prepare and commit staged changes to ${a.name}, gated on user approval at every step.`,
          `# Committing to ${a.name}

This workflow is interactive: never stage extra files, amend, commit or
push until the user approves the relevant step.

1. Inspect the staged changes (\`git status --short\`, \`git diff --cached\`)
   and summarize what they actually change. If nothing is staged, stop and
   ask the user to stage the intended files. Unstaged changes are not part
   of this commit.
2. Scan the staged diff for secrets, credentials, API keys or private
   keys — any suspected secret is a hard stop with no "continue anyway".
   For debug output, stray files, generated/build artifacts or leftover
   TODOs, show the exact file and line and ask whether to continue.
3. ${verify}
4. Read \`git log --oneline -10\`, match this repository's message style
   (imperative subject, under 72 characters), and show the full proposed
   message. Wait for the user to approve, edit or cancel.
5. Commit only after approval; never amend an existing commit. Split
   unrelated work into separate commits.
6. Ask before pushing; never force-push. Report the commit hash, subject
   and push status.`,
        ),
      ];
      if (hasApiLayer(a)) {
        files.push(
          skill(
            'implement-api',
            `Add an API endpoint to ${a.name} following the existing route patterns.`,
            `# Implementing an API endpoint in ${a.name}

1. Read the existing route/handler files${
              a.apiRoutes.length
                ? ` — start with ${a.apiRoutes
                    .slice(0, 3)
                    .map((r) => `\`${r}\``)
                    .join(', ')}`
                : ''
            } —
   and mirror their structure exactly.
2. Validate every input at the boundary; reuse the project's existing
   validation and error-response patterns.
3. Keep the handler thin — put logic in the layer the existing endpoints
   use for it.
4. Add tests covering the success path, validation failures and error
   responses.
5. ${verify}`,
          ),
        );
      }
      if (hasUiLayer(a)) {
        files.push(
          skill(
            'new-screen',
            `Add a screen/page/view to ${a.name} following the existing UI structure.`,
            `# Adding a screen to ${a.name}

1. Find the closest existing screen/page and mirror its file layout,
   naming and component structure.
2. Register it the way the existing screens are — routing/navigation,
   menus, deep links.
3. Reuse the project's shared components and styling conventions; do not
   introduce a new pattern for state or styling.
4. Handle the non-happy paths every screen needs: loading, empty and
   error states.
5. ${verify}`,
          ),
        );
      }
      return files;
    },
  },
  {
    id: 'commands',
    name: 'Slash commands',
    description: 'Claude Code slash commands (.claude/commands/)',
    allowedPaths: ['.claude/commands/'],
    minFiles: 4,
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
    minFiles: 3,
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
    minFiles: 4,
    requiredFiles: [
      'docs/README.md',
      'docs/architecture.md',
      'docs/conventions.md',
      'docs/engineer-workflow.md',
    ],
    prompt: (digest) =>
      commonPrompt(
        `Generate a professional engineering documentation suite under "docs/" —
the documents a staff engineer would hand a new teammate on THIS project.
Decide the set of docs from the codebase itself; only these four are
required in every project:

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

Beyond those, add the specialized docs THIS project's stack actually
warrants. Illustrative examples (pick, rename or invent as the digest
dictates — none are required): "security.md" (secrets/config handling,
input validation, code paths to treat with care), "tech-debt.md" (an
honest register: area | description | impact | suggested fix),
"engineering-standards.md" (the enterprise bar for this stack, how the
repo measures against it today, and the adoption step for each gap —
sourced from the Maturity & gaps of your codebase review),
"roadmap.md" (ONLY when the digest shows real trajectory signals —
CHANGELOG history, ROADMAP/TODO files, half-built modules — with every
item grounded in that evidence, never invented),
"BEHAVIOUR_CONTRACT_TEMPLATE.md" (a fill-in template for specifying
observable behavior before changing it), "design-system.md" for UI
component libraries (split into core/feature/input component docs when
large), "di-registry.md" where dependency injection is used,
"localization.md", "navigation.md", "networking.md",
"shared-utilities.md" — or fully domain-specific docs such as
"data-model.md", "deployment.md", "cli-reference.md" or
"provider-matrix.md" when the digest shows that domain.

Two hard rules: never write a doc the project has no material for —
skipping is correct, generic filler is a failure — and prefer a doc
grounded in the digest's real structure over one from the list above.

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
  {
    id: 'harness',
    name: 'Harness config',
    description: 'Claude Code harness settings (.claude/settings.json)',
    allowedPaths: ['.claude/settings.json'],
    requiredFiles: ['.claude/settings.json'],
    prompt: (digest) =>
      commonPrompt(
        `Generate exactly one file: ".claude/settings.json" — the checked-in
Claude Code harness configuration for this repository. It must be a single
valid JSON object (no comments, no trailing commas) with:

- "$schema": "https://json.schemastore.org/claude-code-settings.json"
- "permissions.allow": permission rules for the commands a session on THIS
  project runs constantly, so they stop prompting: the real verification
  scripts from the digest (test, lint, build, format, typecheck — as the
  developer actually invokes them, e.g. "Bash(npm run test:*)") and
  read-only git inspection ("Bash(git status)", "Bash(git diff:*)",
  "Bash(git log:*)"). Allowlist ONLY commands that appear in the digest and
  are read-only or repo-local. NEVER allowlist anything destructive or
  outward-facing: no push, publish, deploy, tag, rm, sudo, curl, or package
  installs.
- "permissions.deny": deny reads of the secret material this project could
  hold — ".env" files and any credential/key paths the digest shows (e.g.
  "Read(./.env)", "Read(./.env.*)", "Read(./**/*.pem)").
- "hooks": OPTIONAL, and only when the digest shows a command that is
  clearly safe to run automatically (e.g. a formatter). A hook must use a
  command from the digest verbatim, must be read-only or formatting-only,
  and must never commit, push, install or delete. When in doubt, omit
  hooks entirely — a wrong hook is worse than none.

The file is shared by the whole team via git, so keep it minimal and
uncontroversial; personal preferences belong in settings.local.json, which
you must not generate.`,
        digest,
      ),
    fallback: (a) => {
      const allow = new Set<string>(['Bash(git status)', 'Bash(git diff:*)', 'Bash(git log:*)']);
      const commands = new Set([
        ...verificationChecklist(a),
        ...workflowScripts(a).map(([name]) => commandFor(a, name)),
      ]);
      for (const c of commands) {
        allow.add(`Bash(${c})`);
        allow.add(`Bash(${c}:*)`);
      }
      const settings = {
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        permissions: {
          allow: [...allow].sort(),
          deny: ['Read(./.env)', 'Read(./.env.*)', 'Read(./**/*.pem)', 'Read(./**/*.key)'],
        },
      };
      return [{ file: '.claude/settings.json', content: JSON.stringify(settings, null, 2) + '\n' }];
    },
  },
  {
    id: 'ci',
    name: 'CI kit check',
    description: 'GitHub Action that fails when the AI kit is stale (opt-in: devpilot generate ci)',
    allowedPaths: ['.github/workflows/devpilot-sync.yml'],
    requiredFiles: ['.github/workflows/devpilot-sync.yml'],
    optIn: true,
    prompt: (digest) =>
      commonPrompt(
        `Generate exactly one file: ".github/workflows/devpilot-sync.yml" — a
GitHub Actions workflow that keeps this repository's generated AI kit
honest: it runs "npx -y @sonalsithara/devpilot sync --check", which exits
non-zero when the codebase has drifted from the kit recorded in
.devpilot/manifest.json.

Rules for the workflow:
- Trigger on pull_request, and on push only for the default branch the
  digest shows (fall back to "main" if none is visible).
- One job, ubuntu-latest: checkout (actions/checkout@v4), setup-node
  (actions/setup-node@v4) with the Node version the digest shows the
  project uses (engines, CI configs, .nvmrc) or 20 otherwise, then the
  sync --check step. The check is static analysis only — it needs no AI
  provider, no API keys and no secrets; do not reference any.
- The workflow is strictly read-only: it must never commit, push, publish,
  deploy or write to the repository.`,
        digest,
      ),
    fallback: () => [
      {
        file: '.github/workflows/devpilot-sync.yml',
        content: `name: DevPilot kit check

on:
  pull_request:
  push:
    branches: [main]

jobs:
  kit-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      # Static drift check against .devpilot/manifest.json — no AI provider
      # or secrets needed. Exits 1 when the kit is stale.
      - run: npx -y @sonalsithara/devpilot sync --check
`,
      },
    ],
  },
];

export function kindsById(ids: string[]): ArtifactKind[] {
  return ids.length
    ? ARTIFACT_KINDS.filter((k) => ids.includes(k.id))
    : ARTIFACT_KINDS.filter((k) => !k.optIn);
}
