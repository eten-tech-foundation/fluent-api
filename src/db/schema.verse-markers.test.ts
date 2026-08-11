import { describe, expect, it } from 'vitest';

import { insertTranslatedVersesSchema, verseMarkersSchema } from '@/db/schema';

// #263: structural markers stored per verse row. These tests pin the validation
// contract the fluent-web editor writes against, and the injection guard the
// USFM export relies on.

const BASE_ROW = {
  projectUnitId: 1,
  bibleTextId: 10,
  content: 'In the beginning God created the heavens and the earth.',
};

describe('verseMarkersSchema', () => {
  it('accepts a paragraph opening at the verse start', () => {
    expect(
      verseMarkersSchema.parse({ paragraphs: [{ marker: 'p', offset: 0 }] })
    ).toEqual({ paragraphs: [{ marker: 'p', offset: 0 }] });
  });

  it('accepts null (legacy rows carry no markers)', () => {
    expect(verseMarkersSchema.parse(null)).toBeNull();
  });

  it('rejects a marker that could smuggle USFM syntax into the export', () => {
    for (const marker of ['p\nfake', 'p\\v', 'P', 'q-1', '']) {
      expect(
        verseMarkersSchema.safeParse({ paragraphs: [{ marker, offset: 0 }] }).success
      ).toBe(false);
    }
  });

  it('rejects offsets that do not strictly increase', () => {
    expect(
      verseMarkersSchema.safeParse({
        paragraphs: [
          { marker: 'p', offset: 5 },
          { marker: 'q1', offset: 5 },
        ],
      }).success
    ).toBe(false);
  });
});

describe('insertTranslatedVersesSchema with markers', () => {
  it('accepts a row without markers unchanged (backward compatible)', () => {
    const parsed = insertTranslatedVersesSchema.parse(BASE_ROW);
    expect(parsed.markers).toBeUndefined();
  });

  it('accepts a mid-verse paragraph split inside the content', () => {
    const parsed = insertTranslatedVersesSchema.parse({
      ...BASE_ROW,
      markers: { paragraphs: [{ marker: 'q2', offset: 17 }] },
    });
    expect(parsed.markers?.paragraphs).toHaveLength(1);
  });

  it('rejects a paragraph offset beyond the verse content', () => {
    expect(
      insertTranslatedVersesSchema.safeParse({
        ...BASE_ROW,
        content: 'Short.',
        markers: { paragraphs: [{ marker: 'p', offset: 50 }] },
      }).success
    ).toBe(false);
  });

  it('accepts offset 0 while the verse is still empty', () => {
    expect(
      insertTranslatedVersesSchema.safeParse({
        ...BASE_ROW,
        content: '',
        markers: { paragraphs: [{ marker: 'p', offset: 0 }] },
      }).success
    ).toBe(true);
  });
});
