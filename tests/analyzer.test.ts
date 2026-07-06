import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeProject, renderContextMarkdown } from '../src/scan/analyzer.js';

describe('project analyzer', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-scan-'));
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'sample-app',
        dependencies: { react: '^18.0.0', next: '^14.0.0' },
        devDependencies: { vitest: '^2.0.0', eslint: '^9.0.0' },
        scripts: { dev: 'next dev' },
      }),
    );
    fs.mkdirSync(path.join(tmp, 'src', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'app.tsx'), 'export const App = () => null;');
    fs.writeFileSync(path.join(tmp, 'src', 'api', 'users.route.ts'), 'export {}');
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(tmp, 'node_modules', 'react'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'react', 'index.js'), '');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects name, languages, frameworks and dependencies', () => {
    const a = analyzeProject(tmp);
    expect(a.name).toBe('sample-app');
    expect(a.languages.map((l) => l.language)).toContain('TypeScript (React)');
    expect(a.frameworks).toContain('Next.js');
    expect(a.frameworks).toContain('Vitest');
    expect(a.dependencies).toContain('react');
    expect(a.conventions.join(' ')).toContain('ESLint');
  });

  it('ignores node_modules', () => {
    const a = analyzeProject(tmp);
    expect(a.tree).not.toContain('node_modules');
  });

  it('finds API-looking files', () => {
    const a = analyzeProject(tmp);
    expect(a.apiRoutes.some((r) => r.includes('users.route.ts'))).toBe(true);
  });

  it('renders markdown with all sections', () => {
    const md = renderContextMarkdown(analyzeProject(tmp));
    for (const section of ['## Overview', '## Folder Structure', '## Dependencies', '## Coding Conventions', '## API Surface']) {
      expect(md).toContain(section);
    }
  });
});
