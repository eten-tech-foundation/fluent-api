import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger';

import {
  parseDblTimestampSeconds,
  parseDblVerseNumber,
  sanitizeDblTimecodeDiagnosticSamples,
  warnIfAllDblTimecodesDropped,
} from './dbl.timecodes';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const JWT_SHAPED = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.abc123';
const OPAQUE_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';

function lastWarnPayload(): unknown {
  return vi.mocked(logger.warn).mock.calls.at(-1)?.[0];
}

function assertPayloadHasNoSecrets(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(/https?:\/\//i);
  expect(serialized).not.toMatch(/example\.com|evil\.com|amazonaws\.com/i);
  expect(serialized).not.toMatch(/Bearer\s|Signature=|X-Amz-|access_token|api[_-]?key/i);
  expect(serialized).not.toContain('sk-live');
  expect(serialized).not.toContain('secret-value');
  expect(serialized).not.toContain(JWT_SHAPED);
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

describe('sanitizeDblTimecodeDiagnosticSamples', () => {
  it('keeps legitimate chapter-scoped verseIds and clock/decimal starts', () => {
    expect(
      sanitizeDblTimecodeDiagnosticSamples(
        [
          { start: '00:00:05.120', verseId: 'JHN.3.1' },
          { start: '4.5', verseId: 'JHN.3.12' },
          { start: 'not-a-time', verseId: 'JHN.3.2' },
        ],
        'JHN.3'
      )
    ).toEqual([
      { start: '00:00:05.120', verseId: 'JHN.3.1' },
      { start: '4.5', verseId: 'JHN.3.12' },
      { start: '[redacted]', verseId: 'JHN.3.2' },
    ]);
  });

  it('redacts verseIds that fail parseDblVerseNumber structure for the chapter', () => {
    expect(
      sanitizeDblTimecodeDiagnosticSamples(
        [
          { start: '00:00:01.000', verseId: 'JHN.3.x' },
          { start: '00:00:02.000', verseId: 'JHN.4.1' },
          { start: '00:00:03.000', verseId: 'JHN.3.0' },
          { start: '00:00:04.000', verseId: 'JHN.3.1-2' },
        ],
        'JHN.3'
      )
    ).toEqual([
      { start: '00:00:01.000', verseId: '[redacted]' },
      { start: '00:00:02.000', verseId: '[redacted]' },
      { start: '00:00:03.000', verseId: '[redacted]' },
    ]);
  });

  it('redacts JWT-shaped and opaque dotted tokens that previously passed the broad allowlist', () => {
    const samples = sanitizeDblTimecodeDiagnosticSamples(
      [
        { start: '00:00:01.000', verseId: JWT_SHAPED },
        { start: '4.5', verseId: OPAQUE_TOKEN },
        { start: JWT_SHAPED, verseId: 'JHN.3.1' },
      ],
      'JHN.3'
    );
    expect(samples).toEqual([
      { start: '00:00:01.000', verseId: '[redacted]' },
      { start: '4.5', verseId: '[redacted]' },
      { start: '[redacted]', verseId: 'JHN.3.1' },
    ]);
    assertPayloadHasNoSecrets(samples);
  });

  it('redacts URL/credential-bearing fields and marks non-strings', () => {
    const samples = sanitizeDblTimecodeDiagnosticSamples(
      [
        {
          start: 'https://evil.com/audio.mp3?token=secret-value',
          verseId: 'JHN.3.1',
        },
        { start: 12.5, verseId: { nested: true } },
      ],
      'JHN.3'
    );
    expect(samples).toEqual([
      { start: '[redacted]', verseId: 'JHN.3.1' },
      { start: '[invalid-type]', verseId: '[invalid-type]' },
    ]);
    assertPayloadHasNoSecrets(samples);
  });
});

describe('warnIfAllDblTimecodesDropped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns with structurally valid samples when every row is dropped', () => {
    warnIfAllDblTimecodesDropped({
      path: 'playback-audio',
      audioBibleId: 'audio-z',
      chapter: 'JHN.3',
      timecodes: [
        { start: 'bad-a', verseId: 'JHN.3.1' },
        { start: '00:00:05.120', verseId: JWT_SHAPED },
        { start: 'bad-c', verseId: 'JHN.3.3' },
        { start: 'bad-d', verseId: 'JHN.3.4' },
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
          { start: '[redacted]', verseId: 'JHN.3.1' },
          { start: '00:00:05.120', verseId: '[redacted]' },
          { start: '[redacted]', verseId: 'JHN.3.3' },
        ],
      },
    });
    assertPayloadHasNoSecrets(payload);
  });

  it('never emits JWT-shaped verseId or malicious start in the logger payload', () => {
    warnIfAllDblTimecodesDropped({
      path: 'source-audio',
      audioBibleId: 'https://evil.com/bible?api_key=sk-live',
      chapter: 'JHN.3',
      timecodes: [
        { start: 'https://evil.com/x?token=secret-value', verseId: JWT_SHAPED },
        { start: '00:00:05.120', verseId: OPAQUE_TOKEN },
        { start: 'not-a-time', verseId: 'JHN.3.1' },
      ],
      acceptedCount: 0,
    });

    const payload = lastWarnPayload();
    expect(payload).toEqual({
      message: 'All DBL timecodes dropped by shared parser',
      context: {
        path: 'source-audio',
        audioBibleId: '[redacted]',
        chapter: 'JHN.3',
        timecodeCount: 3,
        samples: [
          { start: '[redacted]', verseId: '[redacted]' },
          { start: '00:00:05.120', verseId: '[redacted]' },
          { start: '[redacted]', verseId: 'JHN.3.1' },
        ],
      },
    });
    assertPayloadHasNoSecrets(payload);
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
