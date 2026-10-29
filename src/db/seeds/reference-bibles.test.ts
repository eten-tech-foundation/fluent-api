import { describe, expect, it } from 'vitest';

import { suffixedAbbreviation } from './reference-bibles';

describe('suffixedAbbreviation', () => {
  it('appends the externalId prefix — the shape QA sync collisions produce', () => {
    expect(suffixedAbbreviation('BSB', 'bba9f40183526463-01')).toBe('BSB-bba9f4');
    expect(suffixedAbbreviation('IRV', 'a3644a98420c2703-01')).toBe('IRV-a3644a');
  });

  it('caps the base at 40 chars so a suffixed name always fits the 50-char column', () => {
    const result = suffixedAbbreviation('X'.repeat(60), 'abcdef123456-01');
    expect(result).toBe(`${'X'.repeat(40)}-abcdef`);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});
