import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, EXIT, renderError } from '../src/core/errors.js';

describe('CliError', () => {
  it('defaults to exit code 1', () => {
    const err = new CliError('boom');
    expect(err.exitCode).toBe(EXIT.ERROR);
    expect(err.message).toBe('boom');
    expect(err.hint).toBeUndefined();
  });

  it('carries exit code, hint and cause', () => {
    const cause = new Error('root');
    const err = new CliError('boom', { exitCode: EXIT.UNAVAILABLE, hint: 'try again', cause });
    expect(err.exitCode).toBe(EXIT.UNAVAILABLE);
    expect(err.hint).toBe('try again');
    expect(err.cause).toBe(cause);
  });
});

describe('renderError', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints message and hint for CliError and returns its exit code', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = renderError(new CliError('vault broken', { exitCode: 3, hint: 'run repair' }));
    expect(code).toBe(3);
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('vault broken');
    expect(output).toContain('run repair');
  });

  it('treats unknown errors as bugs and returns 1', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = renderError(new TypeError('undefined is not a function'));
    expect(code).toBe(EXIT.ERROR);
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Unexpected error');
    expect(output).toContain('undefined is not a function');
  });

  it('includes the stack and cause chain with verbose', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new CliError('outer', { cause: new Error('inner-cause') });
    renderError(err, { verbose: true });
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('inner-cause');
  });

  it('handles non-Error throwables', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(renderError('just a string')).toBe(EXIT.ERROR);
  });
});
