import { describe, expect, it } from 'vitest';

import { normalizeIso6393Code } from './iso';

describe('normalizeIso6393Code', () => {
  it('returns a lowercased 3-letter code for valid input', () => {
    expect(normalizeIso6393Code('eng')).toBe('eng');
    expect(normalizeIso6393Code('ENG')).toBe('eng');
    expect(normalizeIso6393Code(' aaa ')).toBe('aaa');
  });

  it('returns null for codes that are not exactly 3 letters', () => {
    expect(normalizeIso6393Code('toolong')).toBeNull();
    expect(normalizeIso6393Code('ab')).toBeNull();
    expect(normalizeIso6393Code('')).toBeNull();
  });

  it('returns null for codes containing non-letter characters', () => {
    expect(normalizeIso6393Code('123')).toBeNull();
    expect(normalizeIso6393Code('a-b')).toBeNull();
    expect(normalizeIso6393Code('a b')).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normalizeIso6393Code(undefined)).toBeNull();
  });
});
