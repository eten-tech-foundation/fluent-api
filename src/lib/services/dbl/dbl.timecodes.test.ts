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
  it('keeps allowlisted format evidence and redacts the rest', () => {
    expect(
      sanitizeDblTimecodeDiagnosticSamples([
        { start: '00:00:05.120', verseId: 'JHN.3.1' },
        { start: '4.5', verseId: 'JHN.3.2' },
        { start: 'not-a-time', verseId: 'JHN.3.x' },
      ])
    ).toEqual([
      { start: '00:00:05.120', verseId: 'JHN.3.1' },
      { start: '4.5', verseId: 'JHN.3.2' },
      { start: '[redacted]', verseId: 'JHN.3.x' },
    ]);
  });

  it('redacts URL, query, and credential-bearing fields', () => {
    const samples = sanitizeDblTimecodeDiagnosticSamples([
      {
        start: 'https://evil.com/audio.mp3?token=secret-value',
        verseId: 'JHN.3.1',
      },
      {
        start: '00:00:01.000',
        verseId: 'https://evil.com/v?Signature=abc&X-Amz-Credential=sk-live',
      },
      {
        start: 'Bearer sk-live',
        verseId: 'JHN.3.3?access_token=abc',
      },
    ]);
    expect(samples).toEqual([
      { start: '[redacted]', verseId: 'JHN.3.1' },
      { start: '00:00:01.000', verseId: '[redacted]' },
      { start: '[redacted]', verseId: '[redacted]' },
    ]);
    assertPayloadHasNoSecrets(samples);
  });

  it('marks non-string fields and caps oversized allowlisted values', () => {
    const oversized = `00:${'1'.repeat(80)}`;
    const samples = sanitizeDblTimecodeDiagnosticSamples([
      { start: 12.5, verseId: { nested: true } },
      { start: oversized, verseId: 'JHN.3.1' },
      null,
      'not-an-object',
    ]);
    expect(samples[0]).toEqual({ start: '[invalid-type]', verseId: '[invalid-type]' });
    expect(samples[1]?.start.endsWith('…')).toBe(true);
    expect(samples[1]?.start.length).toBe(49);
    expect(samples[1]?.verseId).toBe('JHN.3.1');
    expect(samples[2]).toEqual({ start: '[invalid-type]', verseId: '[invalid-type]' });
    expect(samples).toHaveLength(3);
  });
});

describe('warnIfAllDblTimecodesDropped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns with sanitized bounded samples when every row is dropped', () => {
    warnIfAllDblTimecodesDropped({
      path: 'playback-audio',
      audioBibleId: 'audio-z',
      chapter: 'JHN.3',
      timecodes: [
        { start: 'bad-a', verseId: 'JHN.3.1' },
        { start: '00:00:05.120', verseId: 'JHN.3.2' },
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
          { start: '00:00:05.120', verseId: 'JHN.3.2' },
          { start: '[redacted]', verseId: 'JHN.3.3' },
        ],
      },
    });
    assertPayloadHasNoSecrets(payload);
  });

  it('never emits raw malicious start/verseId in the logger payload', () => {
    warnIfAllDblTimecodesDropped({
      path: 'source-audio',
      audioBibleId: 'https://evil.com/bible?api_key=sk-live',
      chapter: 'JHN.3/../secret-value',
      timecodes: [
        {
          start: 'https://evil.com/x?token=secret-value&Signature=abc',
          verseId: 'Bearer sk-live',
        },
      ],
      acceptedCount: 0,
    });

    const payload = lastWarnPayload();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(payload).toEqual({
      message: 'All DBL timecodes dropped by shared parser',
      context: {
        path: 'source-audio',
        audioBibleId: '[redacted]',
        chapter: '[redacted]',
        timecodeCount: 1,
        samples: [{ start: '[redacted]', verseId: '[redacted]' }],
      },
    });
    assertPayloadHasNoSecrets(payload);
    // Independent inspection of the exact object handed to logger.warn
    const context = (payload as { context: Record<string, unknown> }).context;
    expect(JSON.stringify(context.samples)).toBe(
      JSON.stringify([{ start: '[redacted]', verseId: '[redacted]' }])
    );
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
