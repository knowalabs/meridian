import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { projectDir } from '../core/paths.js';
import { DEFAULT_RULES } from '../rules/generators.js';
import { log } from '../core/logger.js';

/**
 * `devpilot init` — create the AI-ready project scaffold:
 *   .devpilot/{project.json, rules.md, prompts/, agents/, context/}
 *   CLAUDE.md, AGENTS.md, README_AI.md
 */
export function initCommand(cwd: string = process.cwd()): number {
  const root = projectDir(cwd);
  const name = path.basename(cwd);
  const created: string[] = [];

  const mkdir = (p: string) => {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      created.push(path.relative(cwd, p) + '/');
    }
  };
  const write = (p: string, content: string) => {
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, content);
      created.push(path.relative(cwd, p));
    }
  };

  mkdir(root);
  for (const sub of ['agents', 'prompts', 'rules', 'context']) mkdir(path.join(root, sub));

  write(
    path.join(root, 'project.json'),
    JSON.stringify({ name, devpilot: 1, createdWith: 'devpilot init' }, null, 2) + '\n',
  );
  write(path.join(root, 'rules.md'), DEFAULT_RULES);

  const pointer = `> AI assistants: read \`.devpilot/context.md\` and \`.devpilot/architecture.md\`
> for project context (generate them with \`devpilot scan\`), and follow the
> rules below.

${DEFAULT_RULES}`;

  write(path.join(cwd, 'CLAUDE.md'), `# ${name} — Claude Instructions\n\n${pointer}`);
  write(path.join(cwd, 'AGENTS.md'), `# ${name} — Agent Instructions\n\n${pointer}`);
  write(
    path.join(cwd, 'README_AI.md'),
    `# ${name} — AI Assistant Guide

This project is managed with [DevPilot](https://devpilot.sh).

| File | Purpose |
| --- | --- |
| \`.devpilot/context.md\` | Generated project context (\`devpilot scan\`) |
| \`.devpilot/architecture.md\` | Architecture summary (\`devpilot scan\`) |
| \`.devpilot/rules.md\` | Canonical rules — source for all instruction files |
| \`CLAUDE.md\` / \`AGENTS.md\` / \`GEMINI.md\` | Tool-specific instructions (\`devpilot rules generate\`) |
| \`.devpilot/prompts/\` | Reusable prompts |
| \`.devpilot/agents/\` | Agent definitions |
`,
  );

  if (created.length === 0) {
    log.ok('Project already initialized — nothing to do.');
  } else {
    log.title('Initialized AI-ready project:\n');
    for (const f of created) log.ok(f);
    log.info(
      `\nNext: ${pc.bold('devpilot scan')} to generate context, ${pc.bold('devpilot rules generate')} for tool instruction files.`,
    );
  }
  return 0;
}
