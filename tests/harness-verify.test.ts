import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectAnalysis } from '../src/scan/analyzer.js';
import type { HarnessEventBody } from '../src/harness/events.js';
import {
  VERIFY_TAIL_CHARS,
  repairPrompt,
  runVerify,
  setVerifyRunnerForTests,
  verifyPlan,
  type StepResult,
} from '../src/harness/verify.js';
import { CliError } from '../src/core/errors.js';

/** Only the fields the verify chain reads. */
function analysis(scripts: Record<string, string>, scriptRunner = 'npm run '): ProjectAnalysis {
  return { scripts, scriptRunner } as ProjectAnalysis;
}

afterEach(() => setVerifyRunnerForTests(null));

describe('verifyPlan', () => {
  it('takes one step per category, skipping formatters and watchers', () => {
    const a = analysis({
      format: 'prettier --write .',
      lint: 'eslint src',
      build: 'tsc',
      test: 'vitest run',
      'test:watch': 'vitest',
      'test:e2e': 'vitest run -c e2e',
      dev: 'tsx src/index.ts',
    });
    expect(verifyPlan(a)).toEqual(['npm run lint', 'npm run build', 'npm run test']);
  });

  it('falls back to a variant when the plain name is missing', () => {
    expect(verifyPlan(analysis({ 'test:unit': 'jest' }))).toEqual(['npm run test:unit']);
  });

  it('runs ecosystem commands as-is', () => {
    const cargo = analysis({ build: 'cargo build', test: 'cargo test', lint: 'cargo clippy' }, '');
    expect(verifyPlan(cargo)).toEqual(['cargo clippy', 'cargo build', 'cargo test']);
    const go = analysis({ test: 'go test ./...', build: 'go build ./...' }, '');
    expect(verifyPlan(go)).toEqual(['go build ./...', 'go test ./...']);
  });

  it('is empty for a project with nothing to run', () => {
    expect(verifyPlan(analysis({ dev: 'vite' }))).toEqual([]);
  });

  it('lets config replace the chain', () => {
    expect(verifyPlan(analysis({ test: 'x' }), ['make check', '  '])).toEqual(['make check']);
  });

  it('rejects an override that needs a shell', () => {
    for (const bad of ['npm test && npm run lint', 'pytest -k "slow"', 'echo $HOME']) {
      expect(() => verifyPlan(analysis({}), [bad])).toThrow(CliError);
    }
  });
});

describe('runVerify', () => {
  function script(results: Record<string, StepResult>): string[] {
    const ran: string[] = [];
    setVerifyRunnerForTests(async (command) => {
      ran.push(command);
      return results[command] ?? { ok: true, code: 0, output: '' };
    });
    return ran;
  }

  it('passes when every step passes', async () => {
    script({});
    const events: HarnessEventBody[] = [];
    const outcome = await runVerify('/p', ['lint', 'test'], (e) => events.push(e), 1);
    expect(outcome).toEqual({ passed: true });
    expect(events.map((e) => e.type)).toEqual([
      'verify.started',
      'verify.step',
      'verify.step',
      'verify.result',
    ]);
  });

  it('stops at the first failure and reports its output', async () => {
    const ran = script({ lint: { ok: false, code: 2, output: 'src/a.ts: bad' } });
    const events: HarnessEventBody[] = [];
    const outcome = await runVerify('/p', ['lint', 'test'], (e) => events.push(e), 2);
    expect(ran).toEqual(['lint']);
    expect(outcome).toEqual({
      passed: false,
      failed: { command: 'lint', code: 2, tail: 'src/a.ts: bad' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'verify.result', attempt: 2, passed: false });
  });

  it('stops quietly when the run is aborted', async () => {
    const controller = new AbortController();
    setVerifyRunnerForTests(async () => {
      controller.abort();
      return { ok: false, code: null, output: '' };
    });
    const events: HarnessEventBody[] = [];
    const outcome = await runVerify('/p', ['test'], (e) => events.push(e), 1, controller.signal);
    expect(outcome).toEqual({ passed: false, aborted: true });
    expect(events.map((e) => e.type)).toEqual(['verify.started']);
  });

  it('runs a real command without a shell, in the project, with CI set', async () => {
    // `node` from PATH rather than process.execPath, which has a space on Windows.
    const outcome = await runVerify(
      process.cwd(),
      ["node -e process.exit(process.env.CI==='1'?3:0)"],
      () => {},
      1,
    );
    expect(outcome.failed?.code).toBe(3);
  });

  it('reports a missing binary as the failure', async () => {
    const outcome = await runVerify('/', ['meridian-no-such-tool --check'], () => {}, 1);
    expect(outcome.failed?.tail).toBe('meridian-no-such-tool: command not found');
  });
});

describe('repairPrompt', () => {
  it('fences the output as untrusted data and forbids weakening tests', () => {
    const prompt = repairPrompt({ command: 'npm run test', code: 1, tail: 'expected 1\n' });
    expect(prompt).toContain('`npm run test` exited with code 1');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('```text\nexpected 1\n```');
    expect(prompt).toContain('Do not weaken, skip or delete tests');
  });

  it('uses a fence longer than any backtick run in the output', () => {
    const prompt = repairPrompt({ command: 't', code: null, tail: 'a ```` b' });
    expect(prompt).toContain('`````text');
    expect(prompt).toContain('did not finish');
  });

  it('keeps tails within the documented cap', () => {
    expect(VERIFY_TAIL_CHARS).toBeGreaterThan(1000);
  });
});
