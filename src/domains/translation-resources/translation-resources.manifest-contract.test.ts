/**
 * Focused prepare-offline content contract: real getPrepareOfflineManifest →
 * real aquifer.client → real Zod, fail-closed fetch fixtures (no live Aquifer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@/lib/types';

import {
  installAquiferFetchStub,
  searchPage,
  textDetails,
  textHit,
  VALID_CONTENT_27B,
} from './translation-resources.manifest-contract.test-helpers';
import { getPrepareOfflineManifest } from './translation-resources.service';

const MANIFEST_PARAMS = {
  projectId: 1,
  languageCode: 'eng',
  bookCode: '1SA',
  startChapter: 9,
  endChapter: 9,
} as const;

const VALID_CONTENT_BYTES = new TextEncoder().encode(JSON.stringify(VALID_CONTENT_27B)).byteLength;

async function runManifest(includeContent = false) {
  return getPrepareOfflineManifest({ ...MANIFEST_PARAMS, includeContent });
}

describe('prepare-offline Aquifer content contract (real client + fetch fixtures)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'valid content control: includeContent=%s yields bytesTotal 27 and optional serializedContent',
    async (includeContent) => {
      const stub = installAquiferFetchStub({
        searchPages: {
          UWTranslationNotes: [searchPage([textHit(101)])],
        },
        detailsById: { 101: textDetails(101) },
      });

      const result = await runManifest(includeContent);

      expect(VALID_CONTENT_BYTES).toBe(27);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok manifest');
      const item = result.data.items[0];
      expect(item?.bytesTotal).toBe(27);
      if (includeContent) {
        expect(item?.serializedContent).toBe(JSON.stringify(VALID_CONTENT_27B));
      } else {
        expect(item?.serializedContent).toBeUndefined();
      }
      stub.expectNoUnexpectedCalls();
    }
  );

  it.each([
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
    ['empty array', []],
    ['empty object', {}],
    ['nested TipTap', { type: 'doc', content: [{ type: 'paragraph', content: [] }] }],
  ] as const)('accepts supported JSON content value: %s', async (_label, content) => {
    const stub = installAquiferFetchStub({
      searchPages: {
        UWTranslationNotes: [searchPage([textHit(101)])],
      },
      detailsById: { 101: textDetails(101, content) },
    });

    const result = await runManifest();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok for content=${_label}`);
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]?.bytesTotal).toBe(
      new TextEncoder().encode(JSON.stringify(content)).byteLength
    );
    stub.expectNoUnexpectedCalls();
  });

  it.each([false, true])(
    'rejects missing details.content for includeContent=%s',
    async (includeContent) => {
      const details = textDetails(101);
      delete (details as { content?: unknown }).content;
      const stub = installAquiferFetchStub({
        searchPages: {
          UWTranslationNotes: [searchPage([textHit(101)])],
        },
        detailsById: { 101: details },
      });

      const result = await runManifest(includeContent);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('missing content must be rejected');
      expect(result.error.code).toBe(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
      expect(result.error.message).toContain('schema validation');
      expect(result.error.message).toContain('content');
      stub.expectNoUnexpectedCalls();
    }
  );

  it('fail-closed stub throws instead of network fallthrough for unexpected Aquifer paths', async () => {
    const stub = installAquiferFetchStub({});
    await expect(fetch('https://api.aquifer.bible/bibles')).rejects.toThrow(/fail-closed/);
    expect(stub.unexpectedCalls).toEqual(['Unexpected Aquifer fetch path (fail-closed): /bibles']);
  });
});
