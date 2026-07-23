import path from 'node:path';
import { ProjectAnalysis } from '../scan/analyzer.js';
import { DEFAULT_RULES } from '../rules/generators.js';

/**
 * Artifact kinds for `devpilot generate`: everything a developer would
 * otherwise hand-write to make a project AI-ready — rules, subagents, skills,
 * slash commands, reusable prompts and onboarding docs. Each kind knows how to
 * prompt an AI provider for project-tailored content and how to fall back to
 * a sensible static version when no provider is available.
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

const scriptRunner = (a: ProjectAnalysis): string =>
  a.frameworks.some((f) => f.includes('pyproject')) ? '' : 'npm run ';

function stack(a: ProjectAnalysis): string {
  const langs = a.languages.map((l) => l.language).join(', ') || 'unknown language';
  return a.frameworks.length ? `${langs} with ${a.frameworks.join(', ')}` : langs;
}

function commonPrompt(kindInstructions: string, digest: string): string {
  return `You are DevPilot, a tool that makes codebases AI-assistant-ready.
Study the project digest below, then generate the requested files. Be specific
to THIS project — name its real frameworks, scripts, directories and
conventions. Never invent files, scripts or commands that do not exist in the
digest. Keep each file focused and under 120 lines.

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
rules for AI assistants working in this repository. Sections: General,
Architecture, Code Style, Testing, Safety. Derive every rule from what the
digest actually shows (frameworks, scripts, directory layout, lint/test
setup). Rules must be imperative one-liners an AI can follow.`,
        digest,
      ),
    fallback: (a) => {
      const conventions = a.conventions.map((c) => `- ${c}`).join('\n');
      const scripts = Object.keys(a.scripts)
        .filter((s) => ['test', 'lint', 'build', 'format'].some((k) => s.startsWith(k)))
        .map((s) => `- Run \`${scriptRunner(a)}${s}\` before considering work done.`)
        .join('\n');
      return [
        {
          file: '.devpilot/rules.md',
          content: `${DEFAULT_RULES}
## Project Specifics

- Stack: ${stack(a)}.
${conventions ? conventions + '\n' : ''}${scripts ? '\n## Verification\n\n' + scripts + '\n' : ''}`,
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
        `Generate 2–4 Claude Code subagent files under ".claude/agents/", each
tailored to this project (e.g. a code reviewer that knows the stack, a test
runner/fixer that uses the real test commands, a domain specialist for the
main subsystem). Each file needs YAML frontmatter:

---
name: kebab-case-name
description: When this agent should be used (one sentence).
---

followed by the agent's system prompt in markdown.`,
        digest,
      ),
    fallback: (a) => [
      {
        file: '.claude/agents/code-reviewer.md',
        content: `---
name: code-reviewer
description: Reviews changes for bugs, style and convention violations before commit.
---

You review code changes in ${a.name} (${stack(a)}).
Check for: logic errors, missing tests, deviations from the conventions in
.devpilot/rules.md, and secrets accidentally committed. Report findings by
file and line, most severe first.
`,
      },
      {
        file: '.claude/agents/test-fixer.md',
        content: `---
name: test-fixer
description: Runs the test suite and fixes failures without changing intended behavior.
---

You fix failing tests in ${a.name}.${
          a.scripts['test'] ? ` Run tests with \`${scriptRunner(a)}test\`.` : ''
        }
Reproduce the failure, find the root cause, apply the smallest fix, and re-run
until green. Never delete or skip a test to make it pass.
`,
      },
    ],
  },
  {
    id: 'skills',
    name: 'Skills',
    description: 'Claude Code skills (.claude/skills/)',
    allowedPaths: ['.claude/skills/'],
    prompt: (digest) =>
      commonPrompt(
        `Generate 1–3 Claude Code skills under ".claude/skills/<skill-name>/SKILL.md",
each capturing a repeatable, project-specific workflow an AI assistant should
follow here (e.g. how to add a feature end-to-end in this architecture, how to
run and debug this project, how to release). Each SKILL.md needs YAML
frontmatter:

---
name: kebab-case-name
description: One sentence saying when to use this skill.
---

followed by concrete, step-by-step instructions referencing real paths and
commands from the digest.`,
        digest,
      ),
    fallback: (a) => [
      {
        file: '.claude/skills/project-conventions/SKILL.md',
        content: `---
name: project-conventions
description: Follow ${a.name}'s conventions when writing or reviewing code.
---

# ${a.name} conventions

- Stack: ${stack(a)}.
${a.conventions.map((c) => `- ${c}`).join('\n') || '- See .devpilot/context.md.'}

Read .devpilot/rules.md and .devpilot/context.md before large changes.
`,
      },
    ],
  },
  {
    id: 'commands',
    name: 'Slash commands',
    description: 'Claude Code slash commands (.claude/commands/)',
    allowedPaths: ['.claude/commands/'],
    prompt: (digest) =>
      commonPrompt(
        `Generate 3–6 Claude Code slash-command files under ".claude/commands/".
Each file is a markdown prompt the developer can invoke as /<filename>; use
$ARGUMENTS where the user's input belongs. Base them on this project's real
workflows and scripts (verify/test loops, linting, releasing, reviewing,
scaffolding a new module in this architecture). Start each file with a
one-line "description:" YAML frontmatter.`,
        digest,
      ),
    fallback: (a) => {
      const files: ArtifactFile[] = [];
      const run = scriptRunner(a);
      const add = (name: string, description: string, body: string) =>
        files.push({
          file: `.claude/commands/${name}.md`,
          content: `---\ndescription: ${description}\n---\n\n${body}\n`,
        });
      if (a.scripts['test'])
        add(
          'test',
          'Run the test suite and fix any failures',
          `Run \`${run}test\`. If anything fails, diagnose the root cause and fix it without weakening the tests, then re-run until green.`,
        );
      if (a.scripts['lint'])
        add(
          'lint',
          'Lint the project and fix violations',
          `Run \`${run}lint\`. Fix every reported problem following the existing code style.`,
        );
      if (a.scripts['build'])
        add(
          'build',
          'Build the project and resolve errors',
          `Run \`${run}build\` and fix any build errors.`,
        );
      add(
        'explain',
        'Explain how a part of this codebase works',
        `Explain how $ARGUMENTS works in ${a.name}. Read the relevant source first; cite files and line numbers.`,
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
        `Generate 2–4 reusable prompt files under ".devpilot/prompts/" that a
developer on this project will actually reach for (e.g. reviewing a PR in
this stack, writing a new module in this architecture, debugging this
runtime). Plain markdown, each starting with a "# Title" line.`,
        digest,
      ),
    fallback: (a) => [
      {
        file: '.devpilot/prompts/review.md',
        content: `# Review a change

Review the current diff in ${a.name} (${stack(a)}) for correctness, test
coverage and convention violations (.devpilot/rules.md). Most severe first.
`,
      },
    ],
  },
  {
    id: 'docs',
    name: 'AI docs',
    description: 'AI onboarding doc (.devpilot/docs/)',
    allowedPaths: ['.devpilot/docs/'],
    prompt: (digest) =>
      commonPrompt(
        `Generate exactly one file: ".devpilot/docs/onboarding.md" — a concise
onboarding document for AI assistants: what the project does, how the
architecture fits together (name the real directories/modules), where to make
common kinds of changes, and how to verify work (real commands only).`,
        digest,
      ),
    fallback: (a) => [
      {
        file: '.devpilot/docs/onboarding.md',
        content: `# ${a.name} — AI onboarding

- Stack: ${stack(a)}.
- Layout:

\`\`\`
${a.tree}
\`\`\`

Run \`devpilot scan\` for full context in .devpilot/context.md.
`,
      },
    ],
  },
];

export function kindsById(ids: string[]): ArtifactKind[] {
  return ids.length ? ARTIFACT_KINDS.filter((k) => ids.includes(k.id)) : ARTIFACT_KINDS;
}
