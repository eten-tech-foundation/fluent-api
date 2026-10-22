import { describe, expect, it } from 'vitest';

import { matchPublicPericopeMembership } from './draft-comments.pericopes';

/** FCBH-shaped chapter: two sections both use raw pericopeNumber `1`. */
const fcbhChapter = [
  {
    pericopeSetId: 9,
    bookId: 40,
    chapterNumber: 5,
    section: 6,
    pericopeNumber: '1',
    pericopeTitle: null as string | null,
  },
  {
    pericopeSetId: 9,
    bookId: 40,
    chapterNumber: 5,
    section: 6,
    pericopeNumber: '1',
    pericopeTitle: null,
  },
  {
    pericopeSetId: 9,
    bookId: 40,
    chapterNumber: 5,
    section: 7,
    pericopeNumber: '1',
    pericopeTitle: null,
  },
];

/** FIA-shaped chapter: null section, public id === raw. */
const fiaChapter = [
  {
    pericopeSetId: 3,
    bookId: 40,
    chapterNumber: 5,
    section: null,
    pericopeNumber: '1',
    pericopeTitle: 'Opening',
  },
  {
    pericopeSetId: 3,
    bookId: 40,
    chapterNumber: 5,
    section: null,
    pericopeNumber: '4a',
    pericopeTitle: 'Next',
  },
];

describe('matchPublicPericopeMembership', () => {
  it('distinguishes FCBH public wire ids 6_1 vs 7_1', () => {
    expect(matchPublicPericopeMembership(fcbhChapter, '6_1')).toEqual({
      pericopeSetId: 9,
      bookId: 40,
      chapterNumber: 5,
      pericopeNumber: '6_1',
      pericopeTitle: null,
    });
    expect(matchPublicPericopeMembership(fcbhChapter, '7_1')).toEqual({
      pericopeSetId: 9,
      bookId: 40,
      chapterNumber: 5,
      pericopeNumber: '7_1',
      pericopeTitle: null,
    });
  });

  it('rejects bare raw 1 when chapter data is sectioned (no public 1)', () => {
    expect(matchPublicPericopeMembership(fcbhChapter, '1')).toBeNull();
  });

  it('accepts FIA null-section public id equal to raw number', () => {
    expect(matchPublicPericopeMembership(fiaChapter, '1')).toEqual({
      pericopeSetId: 3,
      bookId: 40,
      chapterNumber: 5,
      pericopeNumber: '1',
      pericopeTitle: 'Opening',
    });
    expect(matchPublicPericopeMembership(fiaChapter, '4a')?.pericopeNumber).toBe('4a');
  });

  it('rejects malformed or mismatched public ids with no lenient fallback', () => {
    expect(matchPublicPericopeMembership(fcbhChapter, '6-1')).toBeNull();
    expect(matchPublicPericopeMembership(fcbhChapter, '6_')).toBeNull();
    expect(matchPublicPericopeMembership(fcbhChapter, '_1')).toBeNull();
    expect(matchPublicPericopeMembership(fcbhChapter, '8_1')).toBeNull();
    expect(matchPublicPericopeMembership(fiaChapter, '6_1')).toBeNull();
    expect(matchPublicPericopeMembership(fiaChapter, '')).toBeNull();
  });

  it('rejects a public id that only exists outside the authorized chapter rows', () => {
    // Caller already scoped rows to assignment chapter; id from another chapter is absent.
    expect(matchPublicPericopeMembership(fcbhChapter, '5_1')).toBeNull();
    expect(matchPublicPericopeMembership([], '6_1')).toBeNull();
  });
});
