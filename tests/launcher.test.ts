import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/launcher.js';

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('install claude')).toEqual(['install', 'claude']);
  });

  it('keeps double-quoted strings together', () => {
    expect(tokenize('ask "what is this repo"')).toEqual(['ask', 'what is this repo']);
  });

  it('keeps single-quoted strings together', () => {
    expect(tokenize("ask 'hello world' -p openai")).toEqual(['ask', 'hello world', '-p', 'openai']);
  });

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});
