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
  /**
   * Kind ids this kind must see the output of. The pipeline generates them
   * first and passes their files to `prompt` as `upstream`, so a kind can
   * build on what another produced instead of independently reinventing it —
   * `commands` delegates to the skills `skills` just wrote.
   */
  dependsOn?: string[];
  prompt(digest: string, upstream?: ArtifactFile[]): string;
  fallback(analysis: ProjectAnalysis): ArtifactFile[];
}

/** The frontmatter block of a markdown artifact, or null when it has none. */
export function frontmatter(content: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) return null;
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1]!;
      fields[key] = field[2]!.trim();
      continue;
    }
    // Continuation of the previous field: a YAML list item or a wrapped value.
    if (key && line.trim()) fields[key] = `${fields[key]} ${line.trim()}`.trim();
  }
  return fields;
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

/** Top-level entries (files and directories) parsed out of the rendered tree. */
const topLevelEntries = (a: ProjectAnalysis): string[] =>
  a.tree
    .split('\n')
    .filter((line) => /^(├── |└── )/.test(line))
    .map((line) => line.replace(/^(├── |└── )/, ''));

/** Top-level directories parsed out of the rendered tree. */
export function topLevelDirs(a: ProjectAnalysis): string[] {
  return topLevelEntries(a)
    .filter((entry) => entry.endsWith('/'))
    .map((entry) => entry.replace(/\/$/, ''));
}

/** A root-level file matching `pattern`, or null — so a workflow step can cite
 *  the real file when it exists and be written as an adoption step when it
 *  does not. */
const rootFile = (a: ProjectAnalysis, pattern: RegExp): string | null =>
  topLevelEntries(a).find((entry) => !entry.endsWith('/') && pattern.test(entry)) ?? null;

/* ------------------------- skills → slash commands ------------------------- */

/**
 * Workflows live in exactly one place — `.claude/skills/` — and the slash
 * commands are the user-invoked way in. Everything below exists so the
 * `commands` kind can point at the skills the `skills` kind produced instead
 * of writing a second copy of them, which drifts the moment either side
 * changes.
 */
interface SkillRef {
  name: string;
  description: string;
}

/** Name and description of every SKILL.md among `files`. */
function skillIndex(files: ArtifactFile[]): SkillRef[] {
  return files.flatMap((f) => {
    const name = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(f.file)?.[1];
    const description = frontmatter(f.content)?.['description'];
    return name && description ? [{ name, description }] : [];
  });
}

/**
 * The skills a static run generates for this project, read back from the
 * skills kind's own fallback: a delegating command can then never name a
 * skill the run did not write.
 */
const staticSkills = (a: ProjectAnalysis): SkillRef[] =>
  skillIndex(ARTIFACT_KINDS.find((k) => k.id === 'skills')?.fallback(a) ?? []);

/** A slash command that hands off to a skill rather than restating it. */
function delegatingCommand(skill: SkillRef): ArtifactFile {
  const tail = skill.description
    .replace(/^use\s+(this\s+)?(when|for)\s+/i, '')
    .replace(/^./, (c) => c.toLowerCase());
  return {
    file: `.claude/commands/${skill.name}.md`,
    content: `---
description: Run the ${skill.name} workflow — ${tail}
argument-hint: [what to apply it to]
---

Use the \`${skill.name}\` skill — @.claude/skills/${skill.name}/SKILL.md — and
follow it end to end. Its steps, verification and constraints are authoritative;
this command only starts it.

Apply it to \`$ARGUMENTS\` when given. With no argument, use the skill's own
default scope, asking first if the skill says to.
`,
  };
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

/**
 * Verification commands a read-only agent may run: everything in the
 * verification chain except the formatters, which rewrite files.
 */
const inspectionCommands = (a: ProjectAnalysis): string[] =>
  verificationChecklist(a).filter((c) => !/\bformat|\bfmt\b|prettier/i.test(c));

/** The kit files every generated project has, as `@`-references for an agent. */
const kitContext = (extra: string[] = []): string =>
  ['.devpilot/rules.md', 'docs/architecture.md', 'docs/conventions.md', ...extra]
    .map((f) => `@${f}`)
    .join('\n');

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
- Ground every non-obvious claim in evidence: name the file (and symbol) that
  proves it. A convention nobody can point at in the code is an assumption,
  not a convention — either cite it or drop it.
- Structure is part of the quality bar. Use the exact section headings the
  instructions below specify, in that order, so every file in the kit reads
  the same way and an assistant can find what it needs by heading.
- Cross-reference the rest of the kit instead of restating it. These paths
  are always generated alongside your files, so you can rely on them:
  ".devpilot/rules.md" (canonical rules, mirrored into CLAUDE.md/AGENTS.md/
  GEMINI.md), ".devpilot/context.md" (generated project context),
  "docs/architecture.md", "docs/conventions.md", "docs/engineer-workflow.md",
  and ".devpilot/docs/codebase-review.md" (your own review of this codebase).
- When the digest has a "Workspace packages" section, this repository holds
  several projects. Name the packages, state which one a rule or step applies
  to, and use each package's own commands from its own directory — never a
  single set of root commands that only work for one of them.
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
    minFiles: 4,
    prompt: (digest) =>
      commonPrompt(
        `Generate 4–6 Claude Code subagent files under ".claude/agents/", each a
specialist for THIS project — for example: a code reviewer whose checklist is
built from the project's real conventions and bug-prone areas visible in the
code; a test runner/fixer that knows the exact test commands and layout; a
specialist for the project's core subsystem (name it in the project's own
vocabulary); a refactoring guide that knows the module boundaries; a debugger
that knows this runtime's failure modes. Derive the set from the digest —
never generate an agent for a concern this project does not have.

Each file is YAML frontmatter followed by the agent's system prompt:

---
name: kebab-case-name
description: When this agent should be used — one sentence, third person,
  naming the concrete trigger (the kind of file, change or question that
  should route here), not a vague role summary.
model: haiku | sonnet | opus
tools:
  - Read
  - Glob
  - Grep
  - Bash
---

Pick "model" by task weight: mechanical/lookup work → haiku, ordinary
engineering work → sonnet, deep multi-file reasoning or architecture → opus.

Grant the least privilege the job needs, and list the tools explicitly. An
agent that only inspects code gets Read, Glob, Grep and Bash and NOT Edit or
Write — that omission is what makes it read-only, so state in the body that
it reports rather than fixes. List Edit/Write only for an agent whose job is
to change files.

The body uses these headings, in this order, in the project's own vocabulary:

## Scope — the paths/concerns this agent owns, and what it must not touch or
   widen into. One paragraph, concrete.
## Context — the files it reads before starting, as "@path" references on
   their own lines (the kit files listed above, plus the project's own
   load-bearing files from the digest). Say how to treat a conflict between
   docs and code: the code is the evidence.
## Method — a numbered procedure specific to this project: where to look
   first, which boundaries to trace across, which searches to run.
## Checklist — the real checks, grouped under "###" subheadings by the areas
   THIS project actually has (derive them from the digest — e.g. its layers,
   its error-handling contract, its test discipline, its security surface).
   Every item is a concrete, checkable statement about this codebase, not a
   platitude: prefer items an assistant can verify by reading a file or
   running a search.
## Severity — for review/audit agents only: four levels (Critical, High,
   Medium, Low) defined in terms of what actually goes wrong in THIS project's
   domain, not generic definitions.
## Commands — a fenced bash block of the exact commands this agent may run,
   using the project's real scripts from the digest. For a read-only agent,
   every command must be non-mutating: no formatters, no code generation, no
   installs, no writes.
## Output — the literal report template the agent must follow, in a fenced
   block, so its output is consistent run to run.
## Forbidden — the hard boundaries, one per line.

Rules that apply to every agent you generate:
- Every finding or recommendation it reports must carry: severity, "file:line",
  the concrete failure or risk, why that matters in this project, and the
  smallest correct fix.
- Forbid speculation: no claim without a file/line reference or command output
  behind it. Incomplete evidence is reported as an open question, not a defect.
- Findings come first in the output, ordered by severity; no padding with a
  long list of things that passed.
- An agent that can edit must still stop for explicit user approval before any
  destructive or hard-to-reverse step.

Make each agent 60–140 lines. A short, generic agent is a failure.`,
        digest,
      ),
    fallback: (a) => {
      const dirs = topLevelDirs(a);
      const checklist = verificationChecklist(a);
      const inspect = inspectionCommands(a);
      const testCmd = a.scripts['test'] ? commandFor(a, 'test') : null;
      const boundaries = dirs.length ? dirs.map((d) => `\`${d}/\``).join(', ') : 'the project root';
      const chain = checklist.length
        ? checklist.map((c) => `\`${c}\``).join(' → ')
        : "the project's build and tests";
      const READ_ONLY = ['Read', 'Glob', 'Grep', 'Bash'];
      const agent = (
        name: string,
        description: string,
        model: string,
        tools: string[],
        body: string,
      ): ArtifactFile => ({
        file: `.claude/agents/${name}.md`,
        content: `---\nname: ${name}\ndescription: ${description}\nmodel: ${model}\ntools:\n${tools
          .map((t) => `  - ${t}`)
          .join('\n')}\n---\n\n${body}\n`,
      });
      /** Read-only inspection block shared by the reviewing agents. */
      const commandBlock = (extra: string[]): string =>
        ['```bash', ...extra, ...inspect, '```'].join('\n');

      return [
        agent(
          'code-reviewer',
          `Use this agent to review a diff or a named set of files in ${a.name} for correctness, convention violations and unsafe changes before they are committed.`,
          'sonnet',
          READ_ONLY,
          `You review code in \`${a.name}\` (${stack(a)}). You report findings; you never
edit code.

## Scope

Review only the diff or the paths the user names. Read a neighbouring file
when it is needed to prove a finding, but do not widen the review into
unrelated modules, and do not fix, format or regenerate anything.

## Context

Read before reviewing:

${kitContext(['.devpilot/context.md'])}

Docs state intent; the code is the evidence. When they disagree, report the
disagreement instead of assuming the docs are current.

## Method

1. List the files under review${dirs.length ? ` and note which module each belongs to (${boundaries})` : ''}.
2. Read each changed file in full, plus the tests that cover it.
3. Trace the change across module boundaries — a change is only correct if
   every caller it affects is still correct.
4. Grep for the prohibited patterns in the checklist below rather than
   trusting a read-through.
5. Run the read-only commands to confirm what the code actually does${inspect.length ? '' : ' (no verification scripts are configured — say so)'}.
6. Report findings first, ordered by severity. Do not pad the report with a
   list of everything that passed.

Every finding carries: severity, \`file:line\`, the concrete failure, why it
matters in this project, and the smallest correct fix. Where the evidence is
incomplete, report it as an open question rather than a defect.

## Severity

- **Critical** — data loss or corruption, secret/credential exposure, or a
  change that makes the program take a wrong irreversible action.
- **High** — crash, broken behavior, a silently swallowed error, or a
  boundary violation that bypasses the project's error handling.
- **Medium** — unhandled edge case, missing test around risky behavior, or a
  convention violation with a concrete cost.
- **Low** — naming or maintainability issue whose future cost you can state.

## Checklist

### Correctness

- Error and edge paths are handled the way the surrounding code handles them,
  not with a new ad-hoc pattern.
- Failures surface to the caller; nothing is swallowed silently.
- Inputs crossing a boundary (user input, files, network, subprocess) are
  validated before use.

### Tests

- Every behavior change has a matching test${testCmd ? ` runnable with \`${testCmd}\`` : ''}.
- Tests assert observable behavior, not implementation details.
- Failure and edge paths are covered, not only the happy path.
- No test was deleted, skipped or weakened to make the suite pass.

### Conventions

- The change matches \`docs/conventions.md\` and \`.devpilot/rules.md\`.
${a.conventions.length ? a.conventions.map((c) => `- The configured tooling is respected: ${c}.`).join('\n') : '- The change matches the formatting and naming of the file it lives in.'}

### Boundaries

- The diff stays inside ${boundaries}; no drive-by refactors ride along.
- No new dependency is introduced without a stated reason.

### Safety

- No secrets, credentials, tokens or private keys in the diff.
- No generated or build output staged as if hand-written.
- Destructive operations are gated on explicit user approval.

## Commands

${commandBlock([
  'git status --short',
  'git diff -- <target>',
  'git log --oneline -20 -- <target>',
  "grep -RIn '<pattern>' <target>",
])}

Read-only only: never run a formatter, a code generator, an install or
anything that writes to the working tree.

## Output

\`\`\`text
## Findings

### Critical
- [file:line] Finding. Impact. Smallest fix.

### High
- ...

### Medium
- ...

### Low
- ...

## Open Questions
- Only questions that affect correctness.

## Verification
- Commands run and what they showed.

## Summary
X critical, Y high, Z medium, W low.
\`\`\`

Omit empty severity sections. If there are no findings, say so plainly and
state what you could not verify.

## Forbidden

- Editing, formatting or generating any file
- Committing, staging or pushing
- Any claim without a \`file:line\` reference or command output behind it`,
        ),
        agent(
          'test-fixer',
          `Use this agent when ${a.name}'s test suite is failing and the failures need to be diagnosed and fixed without changing intended behavior.`,
          'sonnet',
          [...READ_ONLY, 'Edit', 'Write'],
          `You fix failing tests in \`${a.name}\` (${stack(a)}). You fix the cause, never
the symptom.

## Scope

Work only on the failing tests and the code they exercise. Do not refactor
adjacent code, reformat files or expand the change beyond what the failure
requires.

## Context

Read before starting:

${kitContext()}

## Method

1. ${testCmd ? `Run \`${testCmd}\` and read the failure output in full — the first failure usually explains the rest.` : 'Locate the test suite and run it; read the failure output in full.'}
2. Reduce to the smallest failing case and reproduce it in isolation.
3. Decide which is wrong: the code under test, or the test's expectation.
   State the answer before changing anything.
4. Apply the smallest fix at the cause.
5. Re-run the failing test, then the full chain: ${chain}.
6. Report what was wrong and why the fix is correct.

## Checklist

### Diagnosis

- The root cause is stated in one sentence, with the \`file:line\` it lives at.
- The failure is reproduced before any fix is written.
- A test that asserts outdated behavior is called out explicitly, with the
  reason, before its assertion is changed.

### Fix quality

- No test is deleted, skipped, marked pending or loosened to force a pass.
- No timeout is raised or assertion widened to hide a real race.
- Test isolation holds: no shared state, no reliance on execution order, no
  writes outside a temporary directory.
- The fix does not change behavior the tests were protecting.

## Commands

${commandBlock([testCmd ? `${testCmd} <focused-test-path>` : 'git diff', 'git diff'])}

## Output

\`\`\`text
## Failures
- [file:line] What failed and the one-sentence root cause.

## Fixes applied
- [file:line] What changed and why it is the smallest correct fix.

## Verification
- Commands run and their final status.

## Remaining risk
- Anything still unverified.
\`\`\`

## Forbidden

- Deleting, skipping or weakening a test to make the suite green
- Committing, staging or pushing
- Refactoring beyond what the failure requires`,
        ),
        agent(
          'architect',
          `Use this agent to plan a multi-file change in ${a.name} before writing code, so the implementation respects the existing module boundaries.`,
          'opus',
          READ_ONLY,
          `You plan implementation strategies for \`${a.name}\` (${stack(a)}). You produce
plans; you do not write code.

## Scope

Plan only what the user asked for. Surface anything that would cross a module
boundary, add a dependency or change a public interface — those need explicit
sign-off before implementation starts.

## Context

Read before planning:

${kitContext(['.devpilot/context.md'])}

Then read the modules the change touches${dirs.length ? ` (top-level: ${boundaries})` : ''}, and the closest
existing feature that already does something similar.

## Method

1. Restate the requirement in one sentence, including what is explicitly out
   of scope.
2. Find the closest existing precedent in the codebase and read it — the plan
   should extend an existing pattern rather than invent a new one.
3. Map the change onto the real modules: which file gains what, in what order,
   and which existing helper is reused instead of a new one.
4. Identify the risks: boundary crossings, new dependencies, data/format
   migrations, anything hard to reverse.
5. Define how the change will be verified before it is considered done.

## Checklist

- Every file in the plan already exists or has a stated reason to be created.
- The plan names the pattern it mirrors, with the \`file:line\` of the precedent.
- No new top-level directory or dependency without an explicit justification.
- Public interfaces stay stable, or every caller is listed in the plan.
- Tests are part of the plan, not an afterthought.
- The plan ends with the verification chain: ${chain}.

## Output

\`\`\`text
## Goal
One sentence, plus what is out of scope.

## Plan
1. [path] What changes, and the pattern it mirrors ([file:line]).
2. ...

## Risks and decisions needed
- Anything crossing a boundary or needing sign-off.

## Verification
- The ordered commands that prove the change is done.
\`\`\`

## Forbidden

- Writing or editing implementation code
- Planning changes the user did not ask for
- Naming a file, script or dependency that does not exist in this repository`,
        ),
        agent(
          'debugger',
          `Use this agent to trace a bug or unexpected behavior in ${a.name} to its root cause before any fix is attempted.`,
          'sonnet',
          READ_ONLY,
          `You diagnose defects in \`${a.name}\` (${stack(a)}). You find and prove the root
cause; you do not fix it.

## Scope

Investigate the reported symptom only. Read whatever is needed to prove the
cause, but change nothing — the fix is a separate, deliberate step the user
approves.

## Context

Read before investigating:

${kitContext(['.devpilot/context.md'])}

## Method

1. Restate the symptom precisely: the input, the expected behavior and the
   observed behavior. If any of the three is missing, ask for it first.
2. Reproduce it${testCmd ? ` — ideally as a failing case runnable with \`${testCmd}\`` : ''}. No diagnosis before a reproduction.
3. Locate the entry point${dirs.length ? ` in ${boundaries}` : ''} and trace the real control and data
   flow from there to the symptom, naming each \`file:line\` it passes through.
4. Form one hypothesis at a time and disprove it with evidence from the code
   or a command's output — never from plausibility.
5. State the root cause in one sentence and point at the exact line.
6. Propose the smallest fix at the cause, and the regression test that would
   have caught it.

## Checklist

- The symptom is reproduced before any conclusion is drawn.
- The trace names real files and lines, not a guessed architecture.
- The stated cause explains every observed detail of the symptom, including
  why it does not happen in the passing cases.
- The proposed fix sits at the cause, not where the symptom appears.
- The regression test asserts the intended behavior, not the implementation.

## Commands

${commandBlock(['git log --oneline -20 -- <target>', 'git diff <ref> -- <target>', "grep -RIn '<symbol>' <target>"])}

## Output

\`\`\`text
## Symptom
Input, expected, observed.

## Reproduction
The exact command or steps that trigger it.

## Trace
1. [file:line] What happens here.
2. ...

## Root cause
One sentence, at [file:line].

## Proposed fix
The smallest change, plus the regression test that locks it in.

## Open questions
- Anything the evidence does not settle.
\`\`\`

## Forbidden

- Editing any file
- Proposing a fix before the cause is proven
- Guessing at code you have not read`,
        ),
      ];
    },
  },
  {
    id: 'skills',
    name: 'Skills',
    description: 'Claude Code skills (.claude/skills/)',
    allowedPaths: ['.claude/skills/'],
    minFiles: 6,
    requiredFiles: [
      '.claude/skills/commit/SKILL.md',
      '.claude/skills/handle-errors/SKILL.md',
      '.claude/skills/document/SKILL.md',
    ],
    prompt: (digest) =>
      commonPrompt(
        `Generate 6–10 Claude Code skills, each at
".claude/skills/<skill-name>/SKILL.md", capturing THIS project's actual
repeatable workflows. Derive the set from the codebase itself — its
architecture, layers and everyday engineering tasks — and name each skill
in the project's own vocabulary.

Skills are the kit's single home for workflows: the slash commands generated
alongside them delegate to these files rather than restating them, so any
multi-step procedure this project has belongs here and nowhere else.

Three skills are required in every project, under these exact paths. They
cover universal workflows, but their content must be as project-specific as
the rest — a generic five-liner is a failure in each case.

REQUIRED 1 — ".claude/skills/commit/SKILL.md": the exact ordered
verification chain to run before committing, the repository's real
commit-message conventions, and what must never be staged here.
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

REQUIRED 2 — ".claude/skills/handle-errors/SKILL.md": how this project fails
and what it exposes. Ground every rule in the digest's Code map and source
excerpts: the real error type, result wrapper or exception hierarchy this
code uses (name it) and where it is constructed versus caught; the layer that
turns an internal failure into a user-facing one and what that message must
carry to be actionable; the validation this project performs at its own
boundaries; and what must never escape — secrets, tokens, credentials, raw
stack traces or upstream response bodies. Cover the public-surface half too:
what counts as this project's exported/public API, the rule for an additive
change versus a breaking one, and the requirement to update every caller in
the same change. If the project has no shared error type, say so plainly and
write the adoption step rather than inventing one that does not exist.

REQUIRED 3 — ".claude/skills/document/SKILL.md": the discipline that keeps
user-visible behavior from shipping undocumented. State which documentation
lives where in THIS repository — the README for users, "docs/" for engineers,
inline reference docs where the digest shows them — and the rule for deciding
between them. If the digest shows a changelog, use its real format and state
exactly when an entry is required; if it does not, write adding one as an
explicit adoption step. Include the check that catches the common failure:
a behavior change merged with its documentation still describing the old
behavior.

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
description: When to use this skill — one sentence naming the concrete
  trigger, so an assistant can tell from the description alone whether this
  is the right workflow.
---

followed by a "# Title" line and these headings, in this order:

## When to use — the situations this skill covers, and the neighbouring
   situations it does NOT (name the other skill that does).
## Before you start — the preconditions and the files to read first, as
   "@path" references: the kit files listed above plus this project's own
   load-bearing files.
## Steps — numbered, each one action with the real command or path from the
   digest. A step that says "make the change" is a failure: say where the
   file goes, what it mirrors, and what must be true when it is done.
## Verification — the exact ordered commands that prove the work is correct,
   and what to do when one fails.
## Done when — a short checklist of observable conditions ("- [ ] …"), each
   verifiable by reading a file or running a command.
## Never — the specific mistakes that would break this project, taken from
   its real constraints, not generic advice.

25–70 lines each; every step actionable and grounded in the digest.`,
        digest,
      ),
    fallback: (a) => {
      const dirs = topLevelDirs(a);
      const srcDir = dirs.find((d) => ['src', 'lib', 'app'].includes(d));
      const testDir = dirs.find((d) => ['tests', 'test', '__tests__', 'spec'].includes(d));
      const readme = rootFile(a, /^readme(\.|$)/i);
      const changelog = rootFile(a, /^changelog(\.|$)/i);
      const checklist = verificationChecklist(a);
      const verify = checklist.length
        ? `Verify, in order: ${checklist.map((c) => `\`${c}\``).join(' → ')}.`
        : `Run the project's build/tests to verify.`;
      const testCmd = a.scripts['test'] ? commandFor(a, 'test') : null;
      const sourceHome = srcDir ? `\`${srcDir}/\`` : 'the source tree';
      const testHome = testDir ? `\`${testDir}/\`` : 'the existing test files';
      interface SkillBody {
        title: string;
        when: string;
        before: string[];
        steps: string[];
        verification: string;
        done: string[];
        never: string[];
      }
      const skill = (name: string, description: string, s: SkillBody): ArtifactFile => ({
        file: `.claude/skills/${name}/SKILL.md`,
        content: `---
name: ${name}
description: ${description}
---

# ${s.title}

## When to use

${s.when}

## Before you start

${s.before.join('\n')}

## Steps

${s.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}

## Verification

${s.verification}

## Done when

${s.done.map((d) => `- [ ] ${d}`).join('\n')}

## Never

${s.never.map((n) => `- ${n}`).join('\n')}
`,
      });
      const files: ArtifactFile[] = [
        skill(
          'new-feature',
          `Use when adding new behavior to ${a.name} — a new module, command, endpoint or capability that does not exist yet.`,
          {
            title: `Adding a feature to ${a.name}`,
            when: `Use this when the project must do something it cannot do today. For
changing behavior that already exists use \`fix-bug\`; for restructuring
without a behavior change use \`refactor\`.`,
            before: [
              kitContext(),
              '',
              `Then find the closest existing feature in ${sourceHome} and read it end to
end — the new one mirrors it rather than inventing a second pattern.`,
            ],
            steps: [
              `Restate the feature in one sentence, including what is out of scope.`,
              `Name the precedent you are mirroring (\`file:line\`) — file placement,
   naming, error handling and exports all follow it.`,
              `Implement the smallest complete version in ${sourceHome}. No half-wired
   code paths and no configuration flags nobody asked for.`,
              `Handle the failure paths the surrounding code handles: invalid input,
   missing resources, and whatever this feature can realistically hit.`,
              `Add tests in ${testHome}, in the existing style, covering the happy path
   and at least one failure path.`,
              `Update the docs when the behavior is user-visible — \`README\` for users,
   \`docs/\` for engineers.`,
            ],
            verification: verify,
            done: [
              'The feature works end to end from its real entry point, not only in a test.',
              'Every new failure path is handled and tested.',
              'The change stays inside the module it belongs to.',
              'The full verification chain passes.',
            ],
            never: [
              'Invent a new pattern when an existing one in this repository already fits.',
              'Add a dependency without stating why the existing ones do not suffice.',
              'Leave the feature reachable but unfinished behind a silent flag.',
            ],
          },
        ),
        skill(
          'fix-bug',
          `Use when something in ${a.name} behaves incorrectly and the cause must be found, fixed and locked in by a regression test.`,
          {
            title: `Fixing a bug in ${a.name}`,
            when: `Use this when existing behavior is wrong. If the behavior was never
implemented, use \`new-feature\` instead.`,
            before: [
              kitContext(),
              '',
              `Get the three facts a bug report needs before touching code: the input,
the expected behavior and the observed behavior. Ask if any is missing.`,
            ],
            steps: [
              `Reproduce the bug first${testCmd ? ` — ideally as a failing test (\`${testCmd}\`)` : ''}. No fix before a reproduction.`,
              `Trace the real code path from the symptom back to the cause, citing every
   \`file:line\` it passes through.`,
              `State the root cause in one sentence. If you cannot, keep tracing — a fix
   without a stated cause is a guess.`,
              `Apply the smallest fix at the cause, not a workaround where the symptom
   surfaces.`,
              `Keep the reproduction as a regression test asserting the intended
   behavior, not the implementation.`,
              `Check whether the same cause exists elsewhere in ${sourceHome}; fix or
   report the siblings.`,
            ],
            verification: verify,
            done: [
              'The reproduction fails before the fix and passes after it.',
              'The root cause is written down with its file and line.',
              'No unrelated change rides along with the fix.',
              'The full verification chain passes.',
            ],
            never: [
              'Fix a symptom you cannot trace to a cause.',
              'Loosen an assertion or add a retry to make a flaky failure disappear.',
              'Delete or skip the test that exposed the bug.',
            ],
          },
        ),
        skill(
          'refactor',
          `Use when restructuring ${a.name} without changing behavior — extracting, renaming, moving or deduplicating code.`,
          {
            title: `Refactoring ${a.name}`,
            when: `Use this only when observable behavior stays identical. The moment the
change alters behavior it is a feature or a fix, and belongs in those
workflows instead.`,
            before: [
              kitContext(),
              '',
              `Confirm the suite is green before touching anything${testCmd ? ` (\`${testCmd}\`)` : ''} — a refactor
that starts from red cannot prove it changed nothing.`,
            ],
            steps: [
              `Write down the invariant: what must be observably identical afterwards.`,
              `Confirm the code you are moving is covered by tests. If it is not, add the
   characterization tests first — that is part of the refactor.`,
              `Move in small steps — rename, extract, inline — running the tests between
   steps.`,
              `Keep the module boundaries intact${dirs.length ? ` (${dirs.map((d) => `\`${d}/\``).join(', ')})` : ''}; a refactor that relocates a
   responsibility across a boundary needs sign-off first.`,
              `Keep the public interface stable unless changing it is the point; when it
   changes, update every caller in the same change.`,
              `Delete the code the refactor replaced — a refactor that leaves both paths
   alive has doubled the maintenance instead of reducing it.`,
            ],
            verification: verify,
            done: [
              'Behavior is unchanged: the same tests pass, unmodified.',
              'No dead or duplicated path is left behind.',
              'The public interface is stable, or every caller was updated.',
              'The full verification chain passes.',
            ],
            never: [
              'Mix a behavior change into a refactor commit.',
              'Rewrite tests to match new internals instead of keeping them as the proof.',
              'Refactor code with no test coverage without adding coverage first.',
            ],
          },
        ),
        skill(
          'feature-info',
          `Use when you need to understand and explain how an existing part of ${a.name} works before changing it.`,
          {
            title: `Explaining a feature of ${a.name}`,
            when: `Use this to build an accurate picture before a change, or to answer "how
does this work?". It is read-only — it produces an explanation, not a diff.`,
            before: [kitContext(['.devpilot/context.md'])],
            steps: [
              `Locate the entry point: search ${sourceHome} for the feature's name,
   command, route or user-visible text.`,
              `Trace outward from the entry point, noting each \`file:line\` the control
   and data pass through.`,
              `Read the feature's tests${testDir ? ` in \`${testDir}/\`` : ''} — they document the intended behavior and
   the edge cases someone already thought about.`,
              `Identify the data structures the feature owns and who else touches them.`,
              `Report: what it does, the flow as a file-by-file list, the key types, the
   edge cases covered, and where to change what.`,
            ],
            verification: `Every claim in the explanation points at a \`file:line\`. Anything you could
not confirm is listed as an open question rather than asserted.`,
            done: [
              'The flow is traced from a real entry point, not inferred from names.',
              'Every step of the explanation cites a file and line.',
              'Unverified areas are explicitly listed as open questions.',
            ],
            never: [
              'Describe code you have not opened.',
              'Change any file — this workflow is read-only.',
            ],
          },
        ),
        skill(
          'new-utility',
          `Use when adding a shared helper to ${a.name}, to avoid duplicating one that already exists.`,
          {
            title: `Adding a utility to ${a.name}`,
            when: `Use this when the same logic is needed in more than one place. A helper
with a single caller belongs next to that caller instead.`,
            before: [
              kitContext(),
              '',
              `Search first: grep ${sourceHome} for the likely names and read the
neighbouring helpers. A duplicated utility is a defect, not a convenience.`,
            ],
            steps: [
              `Prove no existing helper does the job; name what you searched for.`,
              `Place it next to similar helpers${srcDir ? ` under \`${srcDir}/\`` : ''}, following the local naming and
   export style.`,
              `Keep it small, single-purpose and free of side effects unless the side
   effect is the point.`,
              `Make the failure behavior explicit: what it does on empty input, invalid
   input and boundary values.`,
              `Add focused tests for those edge cases in ${testHome}.`,
              `Migrate the existing duplicates to it in the same change, so the helper
   actually removes duplication instead of adding a third variant.`,
            ],
            verification: verify,
            done: [
              'No existing helper already covered this — and you can say what you searched.',
              'Edge cases (empty, invalid, boundary) are tested.',
              'Existing duplicates now call the new helper.',
              'The full verification chain passes.',
            ],
            never: [
              'Add a utility without first searching for an existing one.',
              'Give a helper hidden side effects such as I/O or global state.',
              'Leave the duplicated code it was meant to replace in place.',
            ],
          },
        ),
        skill(
          'commit',
          `Use when staged changes to ${a.name} are ready to commit — an interactive workflow that stops for approval at every step.`,
          {
            title: `Committing to ${a.name}`,
            when: `Use this for every commit. It is INTERACTIVE: never stage extra files,
amend, commit or push until the user approves that specific step.`,
            before: [
              kitContext(),
              '',
              `Only staged changes are in scope. Unstaged work is not part of this
commit and must not be staged on the user's behalf.`,
            ],
            steps: [
              `Inspect the staged changes (\`git status --short\`, \`git diff --cached\`) and
   summarize what they actually change. If nothing is staged, stop and ask
   the user to stage the intended files.`,
              `Scan the staged diff for secrets, credentials, API keys or private keys —
   any suspected secret is a hard stop with no "continue anyway" option. For
   debug output, stray files, generated/build artifacts or leftover TODOs,
   show the exact file and line and ask whether to continue.`,
              `Run the verification chain below and report the result before proposing a
   message. A failing chain is a stop, not a warning.`,
              `Read \`git log --oneline -10\`, match this repository's real message style
   (imperative subject, under 72 characters), and show the full proposed
   message. Wait for the user to approve, edit or cancel.`,
              `Commit only after approval; never amend an existing commit and never
   stage files the user did not approve. Split unrelated work into separate
   commits.`,
              `Ask before pushing; never force-push. Report the commit hash, subject and
   push status.`,
            ],
            verification: verify,
            done: [
              'The staged diff was reviewed and summarized back to the user.',
              'The secret scan came back clean, or the user was stopped.',
              'The verification chain passed.',
              'The user approved the exact message that was committed.',
            ],
            never: [
              'Commit without showing the message and waiting for approval.',
              'Amend, rebase or force-push.',
              'Stage files the user did not ask for, including generated output.',
              'Continue past a suspected secret for any reason.',
            ],
          },
        ),
        skill(
          'handle-errors',
          `Use when writing or reviewing failure paths in ${a.name} — raising, catching, reporting an error, or changing what the project exposes to its callers.`,
          {
            title: `Handling errors and public surface in ${a.name}`,
            when: `Use this whenever a change can fail, validates input, or alters an
exported name or signature. It is the standard \`new-feature\`, \`fix-bug\`
and \`new-utility\` all defer to for their failure paths.`,
            before: [
              kitContext(),
              '',
              `Read the error handling this project already has before adding any:
grep ${sourceHome} for its throw/raise/reject sites and for whatever type or
wrapper they use. New code fails the way the surrounding code fails — a
second error convention is a defect, not a preference.`,
            ],
            steps: [
              `Name the failure modes before writing the happy path: invalid input,
   missing resource, upstream failure, and the boundary values this code can
   actually reach.`,
              `Validate at the boundary — the entry point where untrusted data arrives —
   using the validation this project already performs there, and reject early
   rather than defending the same value at every layer below.`,
              `Raise the project's own error type with a message that says what failed,
   what the caller can do about it, and which input caused it. A message a
   user cannot act on is an unhandled error with extra steps.`,
              `Catch only where you can do something about it. Never swallow an error
   into a silent default, and never catch broadly to keep a run alive.`,
              `Check what escapes: no secret, token, credential, raw stack trace or
   upstream response body may reach a log line, a user-facing message or a
   returned value.`,
              `For any change to an exported name, signature or return shape, decide
   additive or breaking. Additive is preferred; breaking means updating every
   caller in ${sourceHome} in the same change and saying so in the docs.`,
              `Test the failure paths, not only the success one — in ${testHome},
   asserting the error the caller actually receives.`,
            ],
            verification: verify,
            done: [
              'Every failure mode named in step 1 is handled and tested.',
              'New errors use the same type and message style as the existing ones.',
              'No secret, token, credential or raw stack trace can reach a log or a caller.',
              'Any changed public signature has all its callers updated in this change.',
              'The full verification chain passes.',
            ],
            never: [
              'Introduce a second error type or reporting convention alongside the existing one.',
              'Swallow an error into a silent default or an empty catch.',
              'Return or log a raw upstream body, stack trace or credential.',
              'Change an exported signature and leave a caller behind.',
            ],
          },
        ),
        skill(
          'document',
          `Use when a change to ${a.name} alters user-visible behavior, public API or setup — before it is committed, not after.`,
          {
            title: `Documenting a change to ${a.name}`,
            when: `Use this as the final step of any change a user or another engineer
would notice. Purely internal restructuring covered by \`refactor\` needs no
documentation change.`,
            before: [
              kitContext(),
              '',
              `Decide the audience first, because it decides the file: something a user
of ${a.name} does belongs in ${readme ? `\`${readme}\`` : 'the README'};
something an engineer working on it needs belongs in \`docs/\`. Read the
neighbouring section before adding one so the new text matches its shape.`,
            ],
            steps: [
              `State the change in one sentence from the reader's side — what they can
   now do, or what now behaves differently. If you cannot, the change is not
   ready to document.`,
              `Update the user-facing entry point when the change is user-visible:
   ${readme ? `\`${readme}\`` : 'the README'} — installation, usage, options,
   examples. An example that no longer runs is worse than no example.`,
              `Update the engineer-facing docs when the change moves a boundary or adds
   a concept: \`docs/architecture.md\` for structure, \`docs/conventions.md\`
   for a rule others must follow, \`docs/engineer-workflow.md\` for a step in
   the daily loop.`,
              changelog
                ? `Add a \`${changelog}\` entry in this repository's existing format —
   match the neighbouring entries exactly, and write it for someone deciding
   whether to upgrade, not for a reviewer reading the diff.`
                : `This project has no changelog yet. Adopting one is the step that makes
   released behavior traceable — propose adding it rather than assuming it
   exists, and until then record user-visible changes in the ${readme ? `\`${readme}\`` : 'README'}.`,
              `Re-read every doc that mentions the behavior you changed — grep for the
   old name, flag or default. A change merged beside documentation still
   describing the old behavior is the failure this workflow exists to catch.`,
              `Refresh the generated kit when the change altered the project's shape,
   so \`.devpilot/\` and the tool instruction files stop describing the old
   structure: \`devpilot sync\`.`,
            ],
            verification: `Grep the docs for the old name, flag or default you replaced — no stale hit
may remain. Run any command or example you wrote down, exactly as written.${
              checklist.length
                ? ` Then re-run the verification chain: ${checklist.map((c) => `\`${c}\``).join(' → ')}.`
                : ''
            }`,
            done: [
              'The change is described from the reader’s side, in the file its audience reads.',
              'Every command and example added was run as written.',
              'No documentation still describes the replaced behavior.',
              changelog
                ? `\`${changelog}\` has an entry in the existing format.`
                : 'User-visible changes are recorded, and adopting a changelog is proposed.',
            ],
            never: [
              'Document behavior you have not run.',
              'Describe a planned change as if it already shipped.',
              'Hand-edit generated kit files instead of re-running the generator.',
              'Leave a stale reference to the old name, flag or default anywhere in the docs.',
            ],
          },
        ),
      ];
      if (hasApiLayer(a)) {
        files.push(
          skill(
            'implement-api',
            `Use when adding or changing an API endpoint in ${a.name}, following the existing route patterns.`,
            {
              title: `Implementing an API endpoint in ${a.name}`,
              when: `Use this for any change to the request/response surface. Changes behind
the handler belong in \`new-feature\` or \`fix-bug\`.`,
              before: [
                kitContext(),
                '',
                `Read the existing route/handler files${
                  a.apiRoutes.length
                    ? ` — start with ${a.apiRoutes
                        .slice(0, 3)
                        .map((r) => `\`${r}\``)
                        .join(', ')}`
                    : ''
                } and mirror their structure exactly.`,
              ],
              steps: [
                `Write down the contract first: method, path, request shape, response
   shape, and every error response with its status code.`,
                `Mirror the closest existing endpoint's structure — routing registration,
   handler shape, serialization.`,
                `Validate every input at the boundary using the project's existing
   validation and error-response patterns; never trust a client value.`,
                `Keep the handler thin — business logic goes in the layer the existing
   endpoints use for it.`,
                `Return the project's standard error shape on failure; never leak an
   internal exception, stack trace or raw upstream body to the client.`,
                `Add tests covering the success path, validation failures and error
   responses.`,
              ],
              verification: verify,
              done: [
                'The route is registered and reachable the same way the existing ones are.',
                'Every input is validated at the boundary.',
                'Success, validation-failure and error responses are all tested.',
                'The full verification chain passes.',
              ],
              never: [
                'Return an unvalidated client value straight into a query or command.',
                'Log or return secrets, tokens or raw upstream error bodies.',
                'Put business logic directly in the handler.',
              ],
            },
          ),
        );
      }
      if (hasUiLayer(a)) {
        files.push(
          skill(
            'new-screen',
            `Use when adding a screen, page or view to ${a.name}, following the existing UI structure.`,
            {
              title: `Adding a screen to ${a.name}`,
              when: `Use this for a new user-visible surface. Changing an existing screen's
behavior belongs in \`new-feature\` or \`fix-bug\`.`,
              before: [
                kitContext(),
                '',
                `Find the closest existing screen and read it in full — file layout,
naming, state handling and navigation registration all follow it.`,
              ],
              steps: [
                `Mirror the closest existing screen's file layout, naming and component
   structure.`,
                `Register it the way the existing screens are registered — routing,
   navigation, menus, deep links.`,
                `Reuse the project's shared components and styling conventions; do not
   introduce a new state-management or styling pattern for one screen.`,
                `Handle every non-happy path the other screens handle: loading, empty,
   error and permission-denied states.`,
                `Clean up what the screen owns — subscriptions, listeners, timers and
   controllers — when it goes away.`,
                `Add tests for the important state variants, not only the loaded one.`,
              ],
              verification: verify,
              done: [
                "The screen is reachable through the app's real navigation.",
                'Loading, empty and error states all render correctly.',
                'Nothing the screen created outlives it.',
                'The full verification chain passes.',
              ],
              never: [
                'Hardcode strings, colors or spacing the project already has tokens or resources for.',
                'Introduce a second styling or state pattern for a single screen.',
                'Ship a screen whose only handled state is success.',
              ],
            },
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
    dependsOn: ['skills'],
    prompt: (digest, upstream) => {
      const skills = skillIndex(upstream ?? []);
      const delegation = skills.length
        ? `This project's kit already contains these skills, each at
".claude/skills/<name>/SKILL.md":

${skills.map((s) => `- ${s.name} — ${s.description}`).join('\n')}

Produce, in this order:

1. One DELEGATING command per skill listed above, at
   ".claude/commands/<the-skill's-own-name>.md" — same name, so a developer
   who knows one surface knows the other. Each is a handoff of 4–8 lines
   total: frontmatter, one line naming the skill to use and its SKILL.md
   path, and one line saying what "$ARGUMENTS" scopes and what the command
   does when it is empty. Restating the skill's steps, verification or
   constraints is a failure — a workflow that lives in two files drifts in
   two directions.

2. Three to five COMMAND-ONLY files for one-shot session actions that no
   skill above covers: running one of this project's real scripts and fixing
   what it reports, running the full verification chain in order, reviewing
   the current diff read-only, and cleaning up only what the current session
   changed. None of these may reuse a skill's name.`
        : `Generate 5–7 command files covering this project's real one-shot actions:
running its actual scripts and fixing what they report, running the full
verification chain, reviewing the current diff read-only, and cleaning up
what the current session changed.`;
      return commonPrompt(
        `Generate the slash-command layer of this project's kit under
".claude/commands/". Each file is a markdown prompt the developer invokes as
/<filename>. Slash commands are the user-invoked surface; the skills under
".claude/skills/" are where multi-step workflows live. A command therefore
either delegates to a skill or covers a one-shot action no skill owns.

${delegation}

The cleanup command is scoped, not repo-wide: it establishes which files the
current task changed from the conversation plus the diff, audits only those
against this project's real conventions, and makes behavior-preserving edits
only — naming the concrete smells that matter in this stack (leftover debug
output, dead code, logic duplicated from a helper this project already has,
hardcoded values that belong in its config or token layer, stale generated
output, missing tests) rather than generic advice.

Frontmatter for every command, delegating or not:

---
description: One line, imperative, saying what running it does.
argument-hint: <what-the-user-types>   # only for commands that use $ARGUMENTS
allowed-tools: Read, Grep, Glob, Bash  # only when the command should be
                                       # restricted (e.g. a read-only review)
---

Use "$ARGUMENTS" where the user's input belongs, and say explicitly what the
command does when it is empty — defaulting to the whole diff, asking, or
failing are all fine, but it must be stated.

A delegating command has no headings; it is a handoff, not a procedure.
The body of a command-only file uses these headings:

## Context — the files and command output to read before acting, with the
   real paths from the digest.
## Task — numbered steps, each naming the concrete command or path.
## Report — what to output, in what shape.

Add a "## Constraints" section for anything the command must not do. A
command that can change files states whether it stops for approval first.
Each command-only body is 10–30 lines and executable without the developer
explaining anything further.`,
        digest,
      );
    },
    fallback: (a) => {
      const files: ArtifactFile[] = [];
      const add = (
        name: string,
        description: string,
        body: string,
        meta: { argumentHint?: string; allowedTools?: string } = {},
      ): void => {
        const front = [
          `description: ${description}`,
          ...(meta.argumentHint ? [`argument-hint: ${meta.argumentHint}`] : []),
          ...(meta.allowedTools ? [`allowed-tools: ${meta.allowedTools}`] : []),
        ].join('\n');
        files.push({
          file: `.claude/commands/${name}.md`,
          content: `---\n${front}\n---\n\n${body}\n`,
        });
      };
      const checklist = verificationChecklist(a);
      const chain = checklist.length
        ? checklist.map((c) => `\`${c}\``).join(' → ')
        : 'the build and the tests';
      for (const [script] of workflowScripts(a)) {
        const cmdName = script.replace(/[:.]/g, '-');
        const cmd = commandFor(a, script);
        add(
          cmdName,
          `Run ${cmd} and fix anything it reports`,
          `## Context

Run \`${cmd}\` and read its output in full before changing anything. If
\`$ARGUMENTS\` names a path or test, scope the run to it; otherwise run it
across the whole project.

## Task

1. Run \`${cmd}\`.
2. If it passes, stop and say so — do not make changes nobody asked for.
3. If it fails, diagnose the root cause of the first failure before touching
   the rest; later failures are often the same cause.
4. Fix at the cause, then re-run until it passes.

## Report

The failures, the root cause of each, the fix applied, and the final status.

## Constraints

- Never weaken a test, silence a check or disable a rule to make it pass.
- Never commit, stage or push.`,
          { argumentHint: '[path or test name]' },
        );
      }
      add(
        'verify',
        'Run the full verification chain and fix failures',
        `## Context

This project's verification chain, in order: ${chain}. Run it in this order —
a later step is meaningless if an earlier one is red.

## Task

1. Run each step in order, stopping at the first failure.
2. Diagnose and fix at the root cause, then restart the chain from the top.
3. Repeat until every step is green.

## Report

Which step failed, the root cause, the fix applied, and the final status of
the whole chain.

## Constraints

- Never skip a step or reorder the chain.
- Never lower a threshold, disable a rule or delete a test to get to green.
- Never commit, stage or push.`,
      );
      add(
        'review',
        'Review the current diff against project conventions',
        `## Context

Read \`.devpilot/rules.md\`, \`docs/conventions.md\` and the diff itself:

\`\`\`bash
git status --short
git diff
\`\`\`

Review \`$ARGUMENTS\` when it names files; otherwise review the whole
uncommitted diff.

## Task

1. Read each changed file in full, plus the tests covering it.
2. Check correctness, tests, conventions, scope and secrets — in that order.
3. Verify each finding against the actual code before reporting it.

## Report

Findings ordered by severity (Critical, High, Medium, Low). For each:
\`file:line\`, the concrete failure, why it matters here, and the smallest
fix. Then a one-line verdict. Say so plainly when there are no findings.

## Constraints

- Read-only: report findings, do not fix them.
- No claim without a \`file:line\` behind it.`,
        { argumentHint: '[files to review]', allowedTools: 'Read, Grep, Glob, Bash' },
      );
      const dirs = topLevelDirs(a);
      const helperHomes = dirs.length
        ? `the existing helpers in ${dirs.map((d) => `\`${d}/\``).join(', ')}`
        : 'a helper this project already has';
      const tooling = a.conventions.length
        ? a.conventions.join('; ')
        : 'no formatter or linter config detected — match the surrounding file';
      add(
        'cleanup',
        'Clean up the code this session changed, without changing behavior',
        `## Context

Clean up only what the current task changed in ${a.name} — nothing else. For
restructuring the codebase beyond this session's diff, use the \`refactor\`
skill instead. Establish this command's scope from the conversation plus:

\`\`\`bash
git status --short
git diff
\`\`\`

Scope to \`$ARGUMENTS\` when it names files or a base ref; otherwise take the
uncommitted diff. Changes already in the tree that this session did not make
are out of scope. Read \`.devpilot/rules.md\` and \`docs/conventions.md\`
first — tooling that must stay satisfied: ${tooling}.

## Task

1. List the in-scope files and state the scope before editing anything.
2. Audit each one for: leftover debug output and commented-out code, unused
   imports and unreachable code, comments narrating what the code already
   says, logic duplicated from ${helperHomes}, hardcoded values that belong
   in this project's config or constants, generated output left stale by the
   change, and behavior added this session without a test.
3. Apply behavior-preserving edits only — same inputs, same outputs, same
   public surface. Leave an intentional TODO in place unless you implement it.
4. Anything that would change behavior, move code across a module boundary or
   add a dependency: report it as a proposal, do not do it.
5. Re-run ${chain} and fix what it reports.

## Report

The files refactored, each change grouped by the problem it resolves, the
result of ${chain}, and anything left as a proposal.

## Constraints

- No behavior changes, no new features, no new dependencies.
- Do not create an abstraction just to save a few lines.
- Never delete or weaken a test to get the chain green.
- Never commit, stage or push.`,
        { argumentHint: '[files or base ref]' },
      );
      // One delegator per skill, same name on both surfaces. A command that
      // repeated the skill's steps would be a second copy to keep in sync.
      const taken = new Set(files.map((f) => f.file));
      for (const skill of staticSkills(a)) {
        const command = delegatingCommand(skill);
        if (taken.has(command.file)) continue;
        taken.add(command.file);
        files.push(command);
      }
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
        `Generate 3–5 reusable prompt files under ".devpilot/prompts/" that a
developer on this project will actually reach for — e.g. reviewing a PR in
this stack, implementing a new module following this architecture, debugging
this runtime, writing tests in this project's style.

These are copy-paste prompts for any assistant, so each one must carry its
own context — it cannot assume the reader already loaded the kit. Each file
is plain markdown with a "# Title" line, then:

## When to use — the situation this prompt is for, in one or two lines.
## Context — the project facts the assistant needs: stack, the real paths and
   modules involved, the conventions that constrain the answer. Pulled from
   the digest, stated as facts, not as links to files the reader may not have.
## Task — numbered instructions, each concrete and checkable.
## Output — the exact shape of the expected answer.

End with a fenced placeholder block the developer fills in (the diff, the
symptom, the module name), clearly marked, so the prompt is ready to paste.
Constraints the assistant must respect — read-only, no speculation without a
\`file:line\`, approval before destructive steps — belong in the Task section
as explicit instructions.

40–90 lines each.`,
        digest,
      ),
    fallback: (a) => {
      const checklist = verificationChecklist(a);
      const chain = checklist.length
        ? checklist.map((c) => `\`${c}\``).join(' → ')
        : 'the build and the tests';
      const dirs = topLevelDirs(a);
      const layout = dirs.length ? dirs.map((d) => `\`${d}/\``).join(', ') : 'a flat layout';
      const tooling = a.conventions.length
        ? a.conventions.join('; ')
        : 'no formatter or linter config detected — match the surrounding file';
      return [
        {
          file: '.devpilot/prompts/review.md',
          content: `# Review a change

## When to use

Before a change to ${a.name} is committed or opened as a pull request, to
catch defects while they are still cheap to fix.

## Context

- Project: ${a.name} — ${stack(a)}.
- Top-level layout: ${layout}.
- Tooling that must stay satisfied: ${tooling}.
- Verification chain: ${chain}.

## Task

1. Read every changed file in full, plus the tests covering it — do not review
   from the diff hunks alone.
2. Check, in order: correctness (logic errors, unhandled edge cases, swallowed
   failures), tests (behavior changes without matching tests, tests asserting
   implementation instead of behavior), conventions (violations of the tooling
   and idioms above), scope (drive-by changes outside the stated purpose), and
   safety (secrets, credentials, generated files, destructive operations).
3. Verify each finding against the actual code before reporting it. If the
   evidence is incomplete, report it as an open question, not a defect.
4. Do not fix anything — this is a review.

## Output

Findings ordered by severity (Critical, High, Medium, Low). Each finding:
\`file:line\`, the concrete failure, why it matters in this project, and the
smallest correct fix. Then a one-line verdict: ready to merge, or not. Say so
plainly when there are no findings, and name what you could not verify.

## The change

\`\`\`diff
<paste the diff here>
\`\`\`
`,
        },
        {
          file: '.devpilot/prompts/new-module.md',
          content: `# Implement a new module

## When to use

When adding a new module, component or subsystem to ${a.name} that should look
like it was always part of the codebase.

## Context

- Project: ${a.name} — ${stack(a)}.
- Top-level layout: ${layout} — the new module belongs inside the existing
  structure; a new top-level directory needs a stated reason.
- Tooling that must stay satisfied: ${tooling}.
- Verification chain: ${chain}.

## Task

1. Read the closest existing module first and name it — the new one mirrors
   its file placement, naming, error handling and exports.
2. State the module's responsibility in one sentence, and what it explicitly
   does not own.
3. Implement the smallest complete version. No half-wired paths, no options
   nobody asked for.
4. Handle the failure paths the surrounding code handles, using the project's
   existing error pattern rather than a new one.
5. Add tests in the existing style, covering the happy path and at least one
   failure path.
6. Run the verification chain and report the result.

## Output

The implementation, plus a short summary: the precedent mirrored (with its
path), the files added or changed, the tests added, and the verification
result.

## The module

\`\`\`text
<name the module and what it must do>
\`\`\`
`,
        },
        {
          file: '.devpilot/prompts/debug.md',
          content: `# Debug an issue

## When to use

When ${a.name} behaves incorrectly and the cause is not yet known.

## Context

- Project: ${a.name} — ${stack(a)}.
- Top-level layout: ${layout}.
- Verification chain: ${chain}.

## Task

1. Restate the symptom as input, expected behavior and observed behavior. If
   one of the three is missing, ask for it before reading code.
2. Reproduce it${a.scripts['test'] ? ` — ideally as a failing test (\`${commandFor(a, 'test')}\`)` : ''}. No diagnosis before a reproduction.
3. Trace the real code path from the symptom back to the cause, citing every
   \`file:line\` it passes through. Never infer a path from file names.
4. State the root cause in one sentence and point at the exact line. The cause
   must explain every detail of the symptom, including why the passing cases
   pass.
5. Apply the smallest fix at the cause, and keep the reproduction as a
   regression test.
6. Run the verification chain and report the result.

## Output

Symptom, reproduction, the trace as a numbered \`file:line\` list, the root
cause in one sentence, the fix, the regression test, and anything the evidence
does not settle.

## The symptom

\`\`\`text
<describe the input, what you expected, and what happened>
\`\`\`
`,
        },
        {
          file: '.devpilot/prompts/write-tests.md',
          content: `# Write tests

## When to use

When existing behavior in ${a.name} needs coverage — before a refactor, after
a bug, or where a risky path is untested.

## Context

- Project: ${a.name} — ${stack(a)}.
- Test command: ${a.scripts['test'] ? `\`${commandFor(a, 'test')}\`` : 'no test script detected — say so before writing tests'}.
- Verification chain: ${chain}.

## Task

1. Read an existing test first and mirror its structure, naming and setup —
   do not introduce a second testing style.
2. Test observable behavior through the public entry point, not private
   internals; a test that breaks on every refactor is a liability.
3. Cover the failure and edge paths, not only the happy path: empty input,
   invalid input, boundaries, and the error each produces.
4. Keep tests isolated — no shared mutable state, no dependence on execution
   order, no writes outside a temporary directory, no real network calls.
5. Verify each new test actually fails when the behavior it asserts is broken.
6. Run the verification chain and report the result.

## Output

The tests, plus a short summary: what is now covered, what is deliberately
not, and any behavior the tests exposed as already broken.

## The target

\`\`\`text
<name the module, function or behavior to cover>
\`\`\`
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

Standards every doc in the suite must meet:
- Evidence over assertion. Each convention, invariant and claim names the
  file (and symbol) that demonstrates it, inline — "…, as in
  \`src/foo/bar.ts\`". A claim with nothing behind it is filler; cut it.
- Open with a one-paragraph "what this covers / who should read it" so a
  reader can tell in five seconds whether they are in the right file.
- Close with a "Related" list linking the other docs in the suite that a
  reader would need next, by relative path.
- Prefer a table over prose whenever the content is a set of items with the
  same shape (modules and their responsibilities, commands and what they do,
  debt entries, error types).
- Say what is NOT true as well as what is: the boundaries a module does not
  own, the cases a workflow does not cover. Absence of a caveat reads as a
  guarantee.
- Never document a command, path or dependency that is not in the digest.

Each doc you write should be 40–120 lines and dense with THIS project's
real paths, names and commands.`,
        digest,
      ),
    fallback: (a) => {
      const scripts = workflowScripts(a);
      const checklist = verificationChecklist(a);
      const dirs = topLevelDirs(a);
      /** Busiest files by symbol count — the concrete evidence a doc cites. */
      const busiest = [...a.codeMap]
        .sort((x, y) => y.symbols.length - x.symbols.length)
        .slice(0, 5);
      const related = (...links: [string, string][]): string =>
        `\n## Related\n\n${links.map(([f, why]) => `- [${f}](${f}) — ${why}`).join('\n')}\n`;
      const gaps = raisingTheBar(a);
      return [
        {
          file: 'docs/README.md',
          content: `# ${a.name} — documentation

The engineering documentation for ${a.name} (${stack(a)}). Start with
[architecture.md](architecture.md) if you are new; everything else is
reference you reach for during a specific task.

| Doc | Read this when… |
| --- | --- |
| [architecture.md](architecture.md) | you need the module map and how data flows between them |
| [conventions.md](conventions.md) | you are writing code and want it to match the codebase |
| [engineer-workflow.md](engineer-workflow.md) | you are setting up, running or verifying the project |
| [engineering-standards.md](engineering-standards.md) | you want the quality bar and what this repo still needs to adopt |
| [tech-debt.md](tech-debt.md) | you want to know the known rough edges before touching them |
| [BEHAVIOUR_CONTRACT_TEMPLATE.md](BEHAVIOUR_CONTRACT_TEMPLATE.md) | you are specifying a feature's behavior before changing it |

These docs are the human-facing half of the AI kit; the assistant-facing half
lives in \`.devpilot/rules.md\` and \`.claude/\`. Both are generated by
\`devpilot generate\` — re-run it with an AI provider and \`--force\` for docs
written from an actual reading of the codebase.
`,
        },
        {
          file: 'docs/architecture.md',
          content:
            renderArchitectureMarkdown(a) +
            related(
              ['conventions.md', 'the idioms to follow inside these modules'],
              ['engineer-workflow.md', 'the commands that build and verify them'],
            ),
        },
        {
          file: 'docs/conventions.md',
          content: `# ${a.name} — conventions

How code in this repository is written. Read this before your first change;
the reviewer checks against it. Where this file and the code disagree, the
code wins — fix the file.

## Stack

| Fact | Value |
| --- | --- |
| Stack | ${stack(a)} |
| Files | ${a.totalFiles} |
| Languages | ${a.languages.map((l) => `${l.language} (${l.files})`).join(', ') || 'unknown'} |
| Layout | ${dirs.length ? dirs.map((d) => `\`${d}/\``).join(', ') : 'flat — no top-level module directories'} |

## Tooling

${
  a.conventions.length
    ? `These configs are checked in and authoritative — do not hand-format around them:\n\n${a.conventions.map((c) => `- ${c}`).join('\n')}`
    : '- No formatter or linter config is checked in. Match the style of the surrounding code, and see [engineering-standards.md](engineering-standards.md) for closing that gap.'
}

## Where the weight sits

${
  busiest.length
    ? `The densest modules by declared symbols — read one of these before adding a\nsimilar file, and mirror it:\n\n${busiest
        .map(
          (e) =>
            `- \`${e.file}\` — ${e.symbols.slice(0, 6).join(', ')}${e.symbols.length > 6 ? `, +${e.symbols.length - 6} more` : ''}`,
        )
        .join('\n')}`
    : 'No symbol-dense modules detected yet — mirror the closest existing file.'
}

## Ground rules

- Match the existing formatting, naming and idioms of the file you are in.
- Mirror the closest existing module when adding a new one — placement,
  naming, error handling, exports.
- Handle failures the way the surrounding code handles them; do not introduce
  a second error-handling pattern.
- Validate input where it crosses a boundary (user input, files, network,
  subprocess), not deep inside the call stack.
- Prefer clear, self-explanatory code over comments; comment the "why" only.
- No new dependency and no new top-level directory without a stated reason.
${related(
  ['architecture.md', 'which module a change belongs in'],
  ['engineer-workflow.md', 'how to verify a change once written'],
)}`,
        },
        {
          file: 'docs/engineer-workflow.md',
          content: `# ${a.name} — engineer workflow

Day-to-day mechanics: what to run, in what order, and what "done" means.

## Everyday commands

${
  scripts.length
    ? `| Command | Runs |\n| --- | --- |\n${scripts
        .map(
          ([name, cmd]) =>
            `| \`${commandFor(a, name)}\` | ${a.scriptRunner ? `\`${cmd}\`` : `the ${name} step`} |`,
        )
        .join('\n')}`
    : '- No scripts detected — build and run the project manually.'
}

## Verification

${
  checklist.length
    ? `Run, in order, before considering any work done. A later step is\nmeaningless while an earlier one is red — fix and restart from the top:\n\n${checklist.map((c, i) => `${i + 1}. \`${c}\``).join('\n')}`
    : 'Build and test the project manually; no verification scripts are configured.'
}

## Definition of done

- The behavior works from its real entry point, not only in a test.
- New behavior and new failure paths have tests.
- The verification chain above is green end to end.
- Docs are updated when user-visible behavior changed.
- Nothing unrelated rides along in the change.

## Where things live

\`\`\`
${a.tree}
\`\`\`
${related(
  ['architecture.md', 'what each of those directories is responsible for'],
  ['conventions.md', 'how to write the code that goes in them'],
)}`,
        },
        {
          file: 'docs/engineering-standards.md',
          content: `# ${a.name} — engineering standards

The bar every change is held to, and — honestly — where this repository does
not meet it yet. Read this before proposing process changes.

## The bar

| Area | Standard |
| --- | --- |
| Correctness | Failures surface to the caller; nothing is swallowed silently. |
| Input | Everything crossing a boundary is validated before use. |
| Tests | Every behavior change ships with a test covering it and one failure path. |
| Review | Findings cite \`file:line\` and the smallest correct fix. |
| Secrets | No credentials, tokens or keys in the repository, logs or error output. |
| Reversibility | Destructive or outward-facing steps stop for explicit user approval. |
| Dependencies | A new dependency needs a stated reason the existing ones cannot cover. |

## Where this repo stands

${
  a.conventions.length
    ? `Checked-in tooling that already enforces part of the bar:\n\n${a.conventions.map((c) => `- ${c}`).join('\n')}`
    : 'No formatter, linter or CI configuration is checked in yet.'
}

${
  checklist.length
    ? `Verification chain in place: ${checklist.map((c) => `\`${c}\``).join(' → ')}.`
    : 'No verification chain is configured — nothing currently blocks a broken change.'
}

## Adoption steps

${
  gaps.length
    ? `Each of these is a gap, not a description of today. Close them in order:\n\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
    : 'The tooling baseline is solid — keep tests, lint, formatting and CI green as the project grows.'
}
${related(
  ['tech-debt.md', 'the specific debt items behind these gaps'],
  ['engineer-workflow.md', 'the verification chain these standards rely on'],
)}`,
        },
        {
          file: 'docs/tech-debt.md',
          content: `# ${a.name} — tech debt register

Known debt, recorded so it is paid down deliberately instead of rediscovered
under deadline. Add a row when you find debt or knowingly introduce it — an
unrecorded shortcut is indistinguishable from a bug later.

A row belongs here when the code works but the way it works will cost someone
later. Something that is simply broken is a bug: fix it, do not file it.

| Area | Description | Impact | Suggested fix |
| --- | --- | --- | --- |
| _(none recorded yet)_ | | | |

Impact is what it costs today — slower changes, a class of bug it invites, a
path nobody can test — not how ugly it looks.
${related(
  ['engineering-standards.md', 'the bar these entries fall short of'],
  ['architecture.md', 'which module each entry sits in'],
)}`,
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
