import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initCommand } from '../src/commands/init.js';

describe('devpilot init', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-init-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the full scaffold from the product plan', () => {
    expect(initCommand(tmp)).toBe(0);
    for (const p of [
      '.devpilot/project.json',
      '.devpilot/rules.md',
      '.devpilot/agents',
      '.devpilot/prompts',
      '.devpilot/rules',
      '.devpilot/context',
      'CLAUDE.md',
      'AGENTS.md',
      'README_AI.md',
    ]) {
      expect(fs.existsSync(path.join(tmp, p)), p).toBe(true);
    }
    const project = JSON.parse(
      fs.readFileSync(path.join(tmp, '.devpilot', 'project.json'), 'utf8'),
    );
    expect(project.name).toBe(path.basename(tmp));
  });

  it('is idempotent and never overwrites user edits', () => {
    initCommand(tmp);
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), 'my custom instructions');
    expect(initCommand(tmp)).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8')).toBe('my custom instructions');
  });
});
