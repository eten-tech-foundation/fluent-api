import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger';

import {
  parseDblTimestampSeconds,
  parseDblVerseNumber,
  timecodeShape,
  warnIfAllDblTimecodesDropped,
} from './dbl.timecodes';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const JWT_SHAPED = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.abc123';
const OPAQUE_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
const MALICIOUS_URL = 'https://evil.com/audio.mp3?token=secret-value';

function lastWarnPayload(): unknown {
  return vi.mocked(logger.warn).mock.calls.at(-1)?.[0];
}

function assertPayloadHasNoRawSecrets(payload: unknown, rawValues: string[]): void {
  const serialized = JSON.stringify(payload);
  for (const raw of rawValues) {
    expect(serialized).not.toContain(raw);
  }
  expect(serialized).not.toMatch(/https?:\/\/[a-z]/i);
  expect(serialized).not.toContain('evil.com');
  expect(serialized).not.toContain('secret-value');
  expect(serialized).not.toContain('eyJhbGci');
  expect(serialized).not.toContain(OPAQUE_TOKEN);
}

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

describe('timecodeShape', () => {
  it.each([
    ['00:00:05,120', '99:99:99,999'],
    ['PT5.12S', 'AA9.99A'],
    ['5.12s', '9.99a'],
    ['00:00:05:12', '99:99:99:99'],
    ['MRK.14.1-2', 'AAA.99.9-9'],
    ['mrk.14.1', 'aaa.99.9'],
    ['MRK 14:1', 'AAA 99:9'],
    ['MRK.14.1a', 'AAA.99.9a'],
    ['https://x.com/a?sig=abc', 'aaaaa://a.aaa/a?aaa=aaa'],
  ])('maps %s to format-only shape', (raw, shape) => {
    expect(timecodeShape(raw)).toBe(shape);
  });

  it('length-caps long values and preserves non-string markers', () => {
    const shaped = timecodeShape(JWT_SHAPED);
    expect(shaped.endsWith('…')).toBe(true);
    expect(shaped.length).toBe(33);
    expect(timecodeShape(null)).toBe('[null]');
    expect(timecodeShape(12.5)).toBe('[number]');
  });
});

describe('warnIfAllDblTimecodesDropped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns with format-only shapes when every row is dropped', () => {
    warnIfAllDblTimecodesDropped({
      path: 'playback-audio',
      audioBibleId: 'audio-z',
      chapter: 'JHN.3',
      timecodes: [
        { start: '00:00:05,120', end: '00:00:06,120', verseId: 'MRK.14.1' },
        { start: 'PT5.12S', end: 'PT6S', verseId: 'mrk.14.1' },
        { start: '5.12s', end: '6s', verseId: 'MRK 14:1' },
        { start: 'extra', end: 'row', verseId: 'MRK.14.4' },
      ],
      acceptedCount: 0,
    });

    const payload = lastWarnPayload();
    expect(payload).toEqual({
      message: 'All DBL timecodes dropped by shared parser',
      context: {
        path: 'playback-audio',
        audioBibleId: 'audio-z',
        chapter: 'JHN.3',
        timecodeCount: 4,
        samples: [
          { start: '99:99:99,999', end: '99:99:99,999', verseId: 'AAA.99.9' },
          { start: 'AA9.99A', end: 'AA9A', verseId: 'aaa.99.9' },
          { start: '9.99a', end: '9a', verseId: 'AAA 99:9' },
        ],
      },
    });
  });

  it('never emits raw rejected provider values in the logger payload', () => {
    warnIfAllDblTimecodesDropped({
      path: 'source-audio',
      audioBibleId: 'audio-z',
      chapter: 'JHN.3',
      timecodes: [
        { start: MALICIOUS_URL, end: '1', verseId: JWT_SHAPED },
        { start: '00:00:05.120', end: '00:00:06.000', verseId: OPAQUE_TOKEN },
        { start: 'not-a-time', end: '1', verseId: 'JHN.3.1' },
      ],
      acceptedCount: 0,
    });

    const payload = lastWarnPayload();
    expect(payload).toMatchObject({
      message: 'All DBL timecodes dropped by shared parser',
      context: {
        path: 'source-audio',
        audioBibleId: 'audio-z',
        chapter: 'JHN.3',
        timecodeCount: 3,
        samples: [
          {
            start: timecodeShape(MALICIOUS_URL),
            end: '9',
            verseId: timecodeShape(JWT_SHAPED),
          },
          {
            start: '99:99:99.999',
            end: '99:99:99.999',
            verseId: timecodeShape(OPAQUE_TOKEN),
          },
          { start: 'aaa-a-aaaa', end: '9', verseId: 'AAA.9.9' },
        ],
      },
    });
    assertPayloadHasNoRawSecrets(payload, [MALICIOUS_URL, JWT_SHAPED, OPAQUE_TOKEN, 'not-a-time']);
  });

  it.each([
    ['null', null],
    ['empty', [] as const],
  ])('does not warn when timecodes are %s', (_label, timecodes) => {
    warnIfAllDblTimecodesDropped({
      path: 'source-audio',
      audioBibleId: 'audio-z',
      chapter: 'JHN.3',
      timecodes,
      acceptedCount: 0,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when at least one row was accepted', () => {
    warnIfAllDblTimecodesDropped({
      path: 'source-audio',
      audioBibleId: 'audio-z',
      chapter: 'JHN.3',
      timecodes: [{ start: 'bad', verseId: 'JHN.3.1' }],
      acceptedCount: 1,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
