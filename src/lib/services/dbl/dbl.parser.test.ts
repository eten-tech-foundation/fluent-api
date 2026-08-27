import { describe, expect, it, vi } from 'vitest';

import { extractVersesFromText } from './dbl.parser';

describe('extractVersesFromText', () => {
  it('extracts simple verse markers into a Map keyed by verse number', () => {
    const result = extractVersesFromText('[1] In the beginning [2] the earth was formless.');

    expect(result.get(1)).toBe('In the beginning');
    expect(result.get(2)).toBe('the earth was formless.');
    expect(result.size).toBe(2);
  });

  it('normalizes whitespace and strips USFM quote markers', () => {
    const result = extractVersesFromText('[1]   «Hello»   \n  world  ');

    expect(result.get(1)).toBe('Hello world');
  });

  it('expands a merged verse range like [3-5] to every verse in the range', () => {
    const result = extractVersesFromText('[3-5] Merged verse text');

    expect(result.get(3)).toBe('Merged verse text');
    expect(result.get(4)).toBe('Merged verse text');
    expect(result.get(5)).toBe('Merged verse text');
    expect(result.size).toBe(3);
  });

  it('drops text before the first marker and skips verse 0', () => {
    const result = extractVersesFromText('א Aleph [0] Psalm heading [1] Actual verse');

    expect(result.has(0)).toBe(false);
    expect(result.get(1)).toBe('Actual verse');
    expect(result.size).toBe(1);
  });

  it('rejects a range endpoint that overflows to Infinity instead of hanging or crashing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hugeEndpoint = '9'.repeat(309); // parses to Infinity, not a safe integer

    const start = Date.now();
    const result = extractVersesFromText(`[1-${hugeEndpoint}] some text`);
    const elapsedMs = Date.now() - start;

    expect(result.size).toBe(0);
    expect(elapsedMs).toBeLessThan(1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping invalid verse range'));
  });

  it('rejects a large finite range instead of expanding it into hundreds of thousands of rows', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = extractVersesFromText('[1-500000] some text');

    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping invalid verse range'));
  });

  it('rejects a reversed range where the end is before the start', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = extractVersesFromText('[5-3] some text');

    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping invalid verse range'));
  });

  it('accepts a range right at the cap and rejects one verse past it', () => {
    // Cap is 200 (see MAX_VERSE_RANGE_SIZE): [1-200] is 200 verses (allowed),
    // [1-201] is 201 verses (rejected).
    const allowed = extractVersesFromText('[1-200] text');
    expect(allowed.size).toBe(200);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rejected = extractVersesFromText('[1-201] text');
    expect(rejected.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('warns on a verse count mismatch but still returns the parsed verses', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = extractVersesFromText('[1] only one verse', 5);

    expect(result.size).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Verse count mismatch'));
  });
});
