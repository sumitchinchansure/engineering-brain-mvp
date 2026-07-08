import { describe, it, expect } from 'vitest';
import { canonicalizeName } from '../src/lib/normalize';

describe('canonicalizeName', () => {
  it('lowercases and trims', () => {
    expect(canonicalizeName('  Auth Service ')).toBe('auth service');
  });
  it('collapses internal whitespace', () => {
    expect(canonicalizeName('auth   service')).toBe('auth service');
  });
  it('strips backticks and quotes', () => {
    expect(canonicalizeName('`Redis`')).toBe('redis');
    expect(canonicalizeName('"billing"')).toBe('billing');
  });
  it('drops trailing punctuation', () => {
    expect(canonicalizeName('auth service.')).toBe('auth service');
  });
  it('singularizes long plurals but not short words', () => {
    expect(canonicalizeName('queues')).toBe('queue');
    expect(canonicalizeName('redis')).toBe('redis');
  });
});
