import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getResource, searchAllResources } from '@/lib/services/aquifer/aquifer.client';
import { aquiferResourceDetailsSchema } from '@/lib/services/aquifer/aquifer.types';
import { ok } from '@/lib/types';

import {
  getPrepareOfflineManifest,
  getTranslationImages,
  getTranslationNotes,
  getTranslationQuestions,
} from './translation-resources.service';
import { imageSearchHit, searchEnumeration } from './translation-resources.test-fixtures';
import {
  prepareOfflineManifestResponseSchema,
  translationImagesResponseSchema,
  translationNotesResponseSchema,
  translationQuestionsResponseSchema,
} from './translation-resources.types';

vi.mock('@/lib/services/aquifer/aquifer.client', () => ({
  getResource: vi.fn(),
  searchAllResources: vi.fn(),
}));

// Observed on Aquifer GET /resources/263233, 2026-09-03. API holder, not a mirror.
const licenseInfo = {
  title: 'unfoldingWord® Translation Notes',
  copyright: {
    dates: '2022',
    holder: { name: 'unfoldingWord', url: 'https://unfoldingword.org/utw' },
  },
  licenses: [
    {
      eng: {
        name: 'CC BY-SA 4.0 license',
        url: 'https://creativecommons.org/licenses/by-sa/4.0/legalcode.en',
      },
    },
  ],
  showAdaptationNoticeForEnglish: false,
  showAdaptationNoticeForNonEnglish: true,
};
const hit = {
  id: 263233,
  name: 'Genesis 3:1 (#1)',
  localizedName: 'Genesis 3:1 (#1)',
  mediaType: 'Text',
  languageCode: 'eng',
  grouping: { type: 'Guide', name: 'Translation Notes', collectionCode: 'UWTranslationNotes' },
};
const detail = {
  id: hit.id,
  name: hit.name,
  localizedName: hit.localizedName,
  content: [{ tiptap: { type: 'doc', content: [] } }],
  grouping: { type: 'Guide', name: 'Translation Notes', mediaType: 'Text', licenseInfo },
};

describe('resource license attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(searchAllResources).mockResolvedValue(searchEnumeration([hit]));
    vi.mocked(getResource).mockResolvedValue(ok(aquiferResourceDetailsSchema.parse(detail)));
  });

  it.each([
    ['notes', getTranslationNotes, translationNotesResponseSchema],
    ['questions', getTranslationQuestions, translationQuestionsResponseSchema],
  ] as const)(
    'carries licenseInfo through %s — CC BY-SA attribution obligation; do not drop',
    async (_name, getItems, schema) => {
      const result = await getItems({ bookCode: 'GEN', chapter: 3, verse: 1, languageCode: 'eng' });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Resource hydration failed');
      expect(schema.parse(result.data).items[0]?.licenseInfo).toEqual(licenseInfo);
      expect(result.data.items[0]?.content).toEqual(detail.content);
    }
  );

  it('carries licenseInfo through images — CC BY-SA attribution obligation; do not drop', async () => {
    const imageHit = imageSearchHit(hit.id);
    // Mock Aquifer image details (not a live payload).
    const imageDetail = aquiferResourceDetailsSchema.parse({
      ...detail,
      mediaType: 'Image',
      content: { url: 'https://cdn.example/mock-image.jpg', size: 42 },
      grouping: {
        type: 'Images',
        name: 'Images',
        mediaType: 'Image',
        licenseInfo,
        collectionCode: 'Images',
      },
    });
    vi.mocked(searchAllResources).mockResolvedValue(searchEnumeration([imageHit]));
    vi.mocked(getResource).mockResolvedValue(ok(imageDetail));

    const result = await getTranslationImages({
      bookCode: 'GEN',
      chapter: 3,
      verse: 1,
      languageCode: 'eng',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Image hydration failed');
    expect(translationImagesResponseSchema.parse(result.data).items[0]?.licenseInfo).toEqual(
      licenseInfo
    );
  });

  it('passes through mock caption and attribution on images when Aquifer content has them (#273 / mobile #594)', async () => {
    const imageHit = imageSearchHit(hit.id);
    // Mock Aquifer image details only — not live payload proof.
    const imageDetail = aquiferResourceDetailsSchema.parse({
      ...detail,
      content: {
        url: 'https://cdn.example/mock-image.jpg',
        thumbnailUrl: 'https://cdn.example/mock-thumb.jpg',
        caption: 'Mock map caption',
        attribution: 'Mock explicit credit',
        size: 11,
      },
      grouping: {
        type: 'Images',
        name: 'Images',
        mediaType: 'Image',
        licenseInfo,
        collectionCode: 'Images',
      },
    });
    vi.mocked(searchAllResources).mockResolvedValue(searchEnumeration([imageHit]));
    vi.mocked(getResource).mockResolvedValue(ok(imageDetail));

    const result = await getTranslationImages({
      bookCode: 'GEN',
      chapter: 3,
      verse: 1,
      languageCode: 'eng',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Image hydration failed');
    const item = translationImagesResponseSchema.parse(result.data).items[0];
    expect(item).toMatchObject({
      url: 'https://cdn.example/mock-image.jpg',
      thumbnailUrl: 'https://cdn.example/mock-thumb.jpg',
      caption: 'Mock map caption',
      attribution: 'Mock explicit credit',
      licenseInfo,
      size: 11,
    });
  });

  it('omits caption, attribution, and licenseInfo on images when Aquifer mock omits them (#273 / mobile #594)', async () => {
    const imageHit = imageSearchHit(hit.id);
    const imageDetail = aquiferResourceDetailsSchema.parse({
      ...detail,
      content: { url: 'https://cdn.example/mock-image.jpg', size: 3 },
      grouping: {
        type: 'Images',
        name: 'Images',
        mediaType: 'Image',
        collectionCode: 'Images',
      },
    });
    vi.mocked(searchAllResources).mockResolvedValue(searchEnumeration([imageHit]));
    vi.mocked(getResource).mockResolvedValue(ok(imageDetail));

    const result = await getTranslationImages({
      bookCode: 'GEN',
      chapter: 3,
      verse: 1,
      languageCode: 'eng',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Image hydration failed');
    const item = translationImagesResponseSchema.parse(result.data).items[0];
    expect(item).toMatchObject({
      url: 'https://cdn.example/mock-image.jpg',
      size: 3,
    });
    expect(item).not.toHaveProperty('caption');
    expect(item).not.toHaveProperty('attribution');
    expect(item).not.toHaveProperty('licenseInfo');
    expect(item).not.toHaveProperty('thumbnailUrl');
  });

  it.each([true, false])(
    'carries licenseInfo through the manifest (includeContent=%s) — CC BY-SA attribution obligation; do not drop',
    async (includeContent) => {
      const result = await getPrepareOfflineManifest({
        projectId: 1,
        languageCode: 'eng',
        bookCode: 'GEN',
        startChapter: 3,
        endChapter: 3,
        includeContent,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Manifest failed');
      const parsed = prepareOfflineManifestResponseSchema.parse(result.data);
      expect(parsed.items.length).toBeGreaterThan(0);
      for (const item of parsed.items) expect(item.licenseInfo).toEqual(licenseInfo);
    }
  );

  it.each([
    { copyright: { dates: 2022 }, licenses: [{ eng: 'CC BY-SA 4.0' }] },
    { licenses: ['CC BY-SA 4.0'] },
    'Provider legacy notice',
  ])(
    'keeps the resource and its raw notice when known license fields drift: %j',
    async (notice) => {
      vi.mocked(getResource).mockResolvedValue(
        ok(
          aquiferResourceDetailsSchema.parse({
            ...detail,
            grouping: { ...detail.grouping, licenseInfo: notice },
          })
        )
      );
      const notes = await getTranslationNotes({
        bookCode: 'GEN',
        chapter: 3,
        verse: 1,
        languageCode: 'eng',
      });
      if (!notes.ok) throw new Error('License drift rejected the resource');
      expect(translationNotesResponseSchema.parse(notes.data).items[0]?.licenseInfo).toEqual(
        notice
      );
      const manifest = await getPrepareOfflineManifest({
        projectId: 1,
        languageCode: 'eng',
        bookCode: 'GEN',
        startChapter: 3,
        endChapter: 3,
      });
      if (!manifest.ok) throw new Error('License drift rejected the manifest');
      expect(
        prepareOfflineManifestResponseSchema.parse(manifest.data).items[0]?.licenseInfo
      ).toEqual(notice);
    }
  );

  it('preserves future metadata, partial notices, and missing/null license semantics', async () => {
    const futureNotice = {
      ...licenseInfo,
      extra: 'retain',
      copyright: {
        ...licenseInfo.copyright,
        extra: 'retain nested',
      },
    };
    const parsed = aquiferResourceDetailsSchema.parse({
      ...detail,
      grouping: { ...detail.grouping, licenseInfo: futureNotice },
    });
    expect(parsed.grouping.licenseInfo).toEqual(futureNotice);
    expect(
      aquiferResourceDetailsSchema.parse({
        ...detail,
        grouping: { licenseInfo: { title: 'Partial' } },
      }).grouping.licenseInfo
    ).toEqual({ title: 'Partial' });

    for (const notice of [undefined, null]) {
      vi.mocked(getResource).mockResolvedValue(
        ok(
          aquiferResourceDetailsSchema.parse({
            ...detail,
            grouping: { licenseInfo: notice },
          })
        )
      );
      const result = await getTranslationNotes({
        bookCode: 'GEN',
        chapter: 3,
        verse: 1,
        languageCode: 'eng',
      });
      if (!result.ok) throw new Error('Resource hydration failed');
      expect(result.data.items[0]?.licenseInfo).toBe(notice);
      if (notice === undefined) expect(result.data.items[0]).not.toHaveProperty('licenseInfo');
    }
  });
});
