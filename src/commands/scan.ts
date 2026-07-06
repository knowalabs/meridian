import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { projectDir } from '../core/paths.js';
import {
  analyzeProject,
  renderArchitectureMarkdown,
  renderContextMarkdown,
} from '../scan/analyzer.js';
import { jsonMode, log } from '../core/logger.js';

/** `devpilot scan` — analyze the project and write AI context files. */
export function scanCommand(cwd: string = process.cwd()): number {
  log.info('Scanning project…');
  const analysis = analyzeProject(cwd);

  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });

  const contextFile = path.join(dir, 'context.md');
  const archFile = path.join(dir, 'architecture.md');
  fs.writeFileSync(contextFile, renderContextMarkdown(analysis));
  fs.writeFileSync(archFile, renderArchitectureMarkdown(analysis));

  if (jsonMode()) {
    log.json({
      totalFiles: analysis.totalFiles,
      languages: analysis.languages,
      frameworks: analysis.frameworks,
      files: {
        context: path.relative(cwd, contextFile),
        architecture: path.relative(cwd, archFile),
      },
    });
    return 0;
  }

  log.ok(`Analyzed ${analysis.totalFiles} files`);
  log.ok(`Languages: ${analysis.languages.map((l) => l.language).join(', ') || 'none detected'}`);
  log.ok(`Frameworks: ${analysis.frameworks.join(', ') || 'none detected'}`);
  log.ok(`Wrote ${path.relative(cwd, contextFile)}`);
  log.ok(`Wrote ${path.relative(cwd, archFile)}`);
  log.info(`\nNext: ${pc.bold('devpilot rules generate')} to propagate rules to your AI tools.`);
  return 0;
}
