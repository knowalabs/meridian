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
    expect(a.scriptRunner).toBe('npm run ');
  });

  it('ignores node_modules', () => {
    const a = analyzeProject(tmp);
    expect(a.tree).not.toContain('node_modules');
  });

  it('finds API-looking files', () => {
    const a = analyzeProject(tmp);
    expect(a.apiRoutes.some((r) => r.includes('users.route.ts'))).toBe(true);
  });

  it('derives runnable commands for non-npm ecosystems, Makefile first', () => {
    const rust = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-rust-'));
    try {
      fs.writeFileSync(path.join(rust, 'Cargo.toml'), '[package]\nname = "demo"\n');
      fs.writeFileSync(path.join(rust, 'src.rs'), 'fn main() {}\n');
      fs.writeFileSync(path.join(rust, 'Makefile'), 'test:\n\tcargo nextest run\n\nVAR:=1\n');
      const a = analyzeProject(rust);
      expect(a.scriptRunner).toBe('');
      expect(a.scripts['test']).toBe('make test'); // Makefile wins over cargo default
      expect(a.scripts['lint']).toBe('cargo clippy');
      expect(a.scripts['build']).toBe('cargo build');
    } finally {
      fs.rmSync(rust, { recursive: true, force: true });
    }
  });

  it('derives Python commands from pyproject tool mentions', () => {
    const py = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-py-'));
    try {
      fs.writeFileSync(
        path.join(py, 'pyproject.toml'),
        '[tool.pytest.ini_options]\n[tool.ruff]\nline-length = 100\n',
      );
      const a = analyzeProject(py);
      expect(a.scriptRunner).toBe('');
      expect(a.scripts['test']).toBe('pytest');
      expect(a.scripts['lint']).toBe('ruff check .');
      expect(a.scripts['format']).toBe('ruff format .');
    } finally {
      fs.rmSync(py, { recursive: true, force: true });
    }
  });

  it('detects Elixir, SwiftPM, Deno and .NET projects with their commands', () => {
    const cases: [string, string, string, Record<string, string>][] = [
      ['mix.exs', 'defmodule Demo do\nend\n', 'Elixir (Mix)', { test: 'mix test' }],
      ['Package.swift', '// swift-tools-version:5.9\n', 'Swift (SwiftPM)', { test: 'swift test' }],
      ['deno.json', '{}', 'Deno', { test: 'deno test', format: 'deno fmt' }],
      ['demo.csproj', '<Project />', '.NET', { test: 'dotnet test', build: 'dotnet build' }],
    ];
    for (const [file, content, framework, scripts] of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-eco-'));
      try {
        fs.writeFileSync(path.join(dir, file), content);
        const a = analyzeProject(dir);
        expect(a.frameworks).toContain(framework);
        for (const [name, cmd] of Object.entries(scripts)) expect(a.scripts[name]).toBe(cmd);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('detects Django and Rails on top of their base ecosystems', () => {
    const dj = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-dj-'));
    const rails = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-rails-'));
    try {
      fs.writeFileSync(path.join(dj, 'manage.py'), '#!/usr/bin/env python\n');
      const a = analyzeProject(dj);
      expect(a.frameworks).toContain('Django');
      expect(a.scripts['test']).toBe('python manage.py test');
      expect(a.scripts['dev']).toBe('python manage.py runserver');

      fs.writeFileSync(path.join(rails, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails'\n");
      const r = analyzeProject(rails);
      expect(r.frameworks).toContain('Ruby (Bundler)');
      expect(r.frameworks).toContain('Ruby on Rails');
    } finally {
      fs.rmSync(dj, { recursive: true, force: true });
      fs.rmSync(rails, { recursive: true, force: true });
    }
  });

  it('detects CI systems beyond GitHub Actions as conventions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-ci-'));
    try {
      fs.writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'stages: [test]\n');
      fs.writeFileSync(path.join(dir, 'Jenkinsfile'), 'pipeline {}\n');
      fs.writeFileSync(path.join(dir, 'CODEOWNERS'), '* @owner\n');
      const a = analyzeProject(dir);
      expect(a.conventions).toContain('GitLab CI');
      expect(a.conventions).toContain('Jenkins CI');
      expect(a.conventions).toContain('Code ownership (CODEOWNERS)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders markdown with all sections', () => {
    const md = renderContextMarkdown(analyzeProject(tmp));
    for (const section of [
      '## Overview',
      '## Folder Structure',
      '## Dependencies',
      '## Coding Conventions',
      '## API Surface',
    ]) {
      expect(md).toContain(section);
    }
  });
});
