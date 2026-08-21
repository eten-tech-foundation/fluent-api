import { describe, expect, it } from 'vitest';

import { updateBookDetailsSchema } from './book-details.types';

// #263 / fluent-web#398: each field becomes one plain \h or \mt line in the
// USFM export, so the schema is the only thing standing between user input and
// marker injection.

describe('updateBookDetailsSchema', () => {
  it('accepts a plain header and trims it', () => {
    const parsed = updateBookDetailsSchema.parse({ runningHeader: '  Gênesis  ' });
    expect(parsed.runningHeader).toBe('Gênesis');
  });

  it('clears a field on empty string or null', () => {
    expect(updateBookDetailsSchema.parse({ runningHeader: '   ' }).runningHeader).toBeNull();
    expect(updateBookDetailsSchema.parse({ bookTitle: null }).bookTitle).toBeNull();
  });

  it('rejects values that could smuggle USFM syntax into the export', () => {
    // Backslash and line breaks smuggle markers; the control and separator
    // characters below (NUL, ESC, U+2028, U+2029) can break the line-oriented
    // export just as effectively.
    const values = [
      'Genesis\n\\id EXO',
      'Genesis\\mt',
      'a\rb',
      'a\u0000b',
      'a\u001Bb',
      'a\u2028b',
      'a\u2029b',
    ];
    for (const value of values) {
      expect(updateBookDetailsSchema.safeParse({ runningHeader: value }).success).toBe(false);
    }
  });

  it('requires at least one field', () => {
    expect(updateBookDetailsSchema.safeParse({}).success).toBe(false);
  });

  it('leaves an absent field absent, so the update does not touch it', () => {
    const parsed = updateBookDetailsSchema.parse({ bookTitle: 'First Book of Moses' });
    expect('runningHeader' in parsed && parsed.runningHeader !== undefined).toBe(false);
  });
});
