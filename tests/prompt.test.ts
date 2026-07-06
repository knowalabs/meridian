import { describe, expect, it } from 'vitest';
import { didYouMean } from '../src/core/prompt.js';

describe('didYouMean', () => {
  it('suggests the closest candidate for a small typo', () => {
    expect(didYouMean('claud', ['git', 'claude', 'codex'])).toBe('claude');
    expect(didYouMean('anthropc', ['anthropic', 'openai', 'google'])).toBe('anthropic');
  });

  it('is case-insensitive', () => {
    expect(didYouMean('Claude', ['claude', 'codex'])).toBe('claude');
  });

  it('returns null when nothing is reasonably close', () => {
    expect(didYouMean('kubernetes', ['git', 'node', 'docker'])).toBeNull();
  });
});
