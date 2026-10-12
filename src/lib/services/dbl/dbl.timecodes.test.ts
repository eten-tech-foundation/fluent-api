import { describe, expect, it } from 'vitest';

import { parseDblTimestampSeconds, parseDblVerseNumber } from './dbl.timecodes';

describe('parseDblTimestampSeconds', () => {
  it('parses HH:MM:SS.mmm clock strings (provisional fixture shape)', () => {
    expect(parseDblTimestampSeconds('00:00:00.000')).toBe(0);
    expect(parseDblTimestampSeconds('00:00:05.120')).toBeCloseTo(5.12);
    expect(parseDblTimestampSeconds('00:01:30.500')).toBeCloseTo(90.5);
    expect(parseDblTimestampSeconds('01:00:00.000')).toBe(3600);
  });

  it('parses MM:SS[.frac] clock strings used by playback-audio fixtures', () => {
    expect(parseDblTimestampSeconds('00:00.0')).toBe(0);
    expect(parseDblTimestampSeconds('00:04.5')).toBeCloseTo(4.5);
    expect(parseDblTimestampSeconds('00:05.120')).toBeCloseTo(5.12);
  });

  it('parses decimal-second strings', () => {
    expect(parseDblTimestampSeconds('0')).toBe(0);
    expect(parseDblTimestampSeconds('0.0')).toBe(0);
    expect(parseDblTimestampSeconds('9.0')).toBe(9);
    expect(parseDblTimestampSeconds('12.5')).toBe(12.5);
  });

  it('trims surrounding whitespace', () => {
    expect(parseDblTimestampSeconds(' 00:00:05.120 ')).toBeCloseTo(5.12);
    expect(parseDblTimestampSeconds(' 4.5 ')).toBeCloseTo(4.5);
  });

  it('rejects clock values whose calculated offset is non-finite', () => {
    expect(parseDblTimestampSeconds(`${'9'.repeat(309)}:00:00`)).toBeUndefined();
    expect(parseDblTimestampSeconds(`${'9'.repeat(305)}:00:00`)).toBeUndefined();
  });

  it.each(['', '1wrong', '1:99', '-1', 'Infinity', '1::2', '00:60:00.000', '00:00:60.000'])(
    'rejects malformed timecode %s',
    (value) => expect(parseDblTimestampSeconds(value)).toBeUndefined()
  );

  it('rejects trailing junk on otherwise numeric values', () => {
    expect(parseDblTimestampSeconds('00:00:05.120junk')).toBeUndefined();
    expect(parseDblTimestampSeconds('1.5x')).toBeUndefined();
    expect(parseDblTimestampSeconds('not-a-time')).toBeUndefined();
  });
});

describe('parseDblVerseNumber', () => {
  const chapterPrefix = 'MRK.14.';

  it('accepts a positive decimal verse for the requested chapter', () => {
    expect(parseDblVerseNumber('MRK.14.1', chapterPrefix)).toBe(1);
    expect(parseDblVerseNumber('MRK.14.12', chapterPrefix)).toBe(12);
  });

  it('rejects wrong-chapter verseIds', () => {
    expect(parseDblVerseNumber('JHN.4.1', chapterPrefix)).toBeUndefined();
    expect(parseDblVerseNumber('MRK.13.1', chapterPrefix)).toBeUndefined();
  });

  it('rejects malformed verse suffixes', () => {
    expect(parseDblVerseNumber('MRK.14.0', chapterPrefix)).toBeUndefined();
    expect(parseDblVerseNumber('MRK.14.x', chapterPrefix)).toBeUndefined();
    expect(parseDblVerseNumber('MRK.14.1x', chapterPrefix)).toBeUndefined();
    expect(parseDblVerseNumber('MRK.14.1e1', chapterPrefix)).toBeUndefined();
    expect(parseDblVerseNumber('MRK.14.0x10', chapterPrefix)).toBeUndefined();
    expect(parseDblVerseNumber('MRK.14. 1 ', chapterPrefix)).toBeUndefined();
    expect(parseDblVerseNumber('MRK.14.1-2', chapterPrefix)).toBeUndefined();
  });
});
