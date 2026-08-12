import { describe, expect, it } from 'vitest';

import { insertTranslatedVersesSchema, verseMarkersSchema } from '@/db/schema';

// Section headings carry their own words, which the paragraph records cannot hold: a paragraph
// entry is a marker and an offset into the verse's text, and a heading's text belongs to no verse.
// These pin the shape that fixes it (fluent-web#397).

const BASE_ROW = {
  projectUnitId: 1,
  bibleTextId: 10,
  content: 'In the beginning God created the heavens and the earth.',
};

describe('verseMarkersSchema headings', () => {
  it('accepts a heading block that precedes the verse', () => {
    const parsed = verseMarkersSchema.parse({
      headings: [{ marker: 's1', text: 'The Creation' }],
      paragraphs: [{ marker: 'p', offset: 0 }],
    });

    expect(parsed?.headings).toEqual([{ marker: 's1', text: 'The Creation' }]);
  });

  it('accepts several headings before one verse, in order', () => {
    // A major section head followed by a section head is ordinary USFM.
    const parsed = verseMarkersSchema.parse({
      headings: [
        { marker: 'ms1', text: 'Book One' },
        { marker: 's1', text: 'The Creation' },
      ],
    });

    expect(parsed?.headings?.map(h => h.marker)).toEqual(['ms1', 's1']);
  });

  it('is optional, so rows written before this existed still parse', () => {
    const parsed = verseMarkersSchema.parse({ paragraphs: [{ marker: 'p', offset: 0 }] });

    expect(parsed?.headings).toBeUndefined();
  });

  it('refuses a marker that is not a heading', () => {
    // \p is a paragraph, not a heading: allowing it here would let a caller emit body text as a
    // heading block and lose it from the verse.
    for (const marker of ['p', 'q1', 'li2', 'tr']) {
      expect(verseMarkersSchema.safeParse({ headings: [{ marker, text: 'x' }] }).success).toBe(
        false
      );
    }
  });

  it('refuses heading text that could smuggle USFM syntax into the export', () => {
    for (const text of ['The Creation\n\\v 1 hijacked', 'A\\s2 B', 'line\rbreak']) {
      expect(
        verseMarkersSchema.safeParse({ headings: [{ marker: 's1', text }] }).success
      ).toBe(false);
    }
  });

  it('refuses an empty heading, which would export as a bare marker', () => {
    expect(verseMarkersSchema.safeParse({ headings: [{ marker: 's1', text: '   ' }] }).success).toBe(
      false
    );
  });
});

describe('insertTranslatedVersesSchema with headings', () => {
  it('accepts a verse carrying both a heading and its paragraph', () => {
    const parsed = insertTranslatedVersesSchema.parse({
      ...BASE_ROW,
      markers: {
        headings: [{ marker: 's1', text: 'The Creation' }],
        paragraphs: [{ marker: 'p', offset: 0 }],
      },
    });

    expect(parsed.markers?.headings).toHaveLength(1);
  });

  it('accepts a heading on a verse with no paragraph records of its own', () => {
    const parsed = insertTranslatedVersesSchema.parse({
      ...BASE_ROW,
      markers: { headings: [{ marker: 's2', text: 'A Section' }] },
    });

    expect(parsed.markers?.paragraphs).toBeUndefined();
  });
});
