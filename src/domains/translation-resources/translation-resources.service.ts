import type {
  AquiferResourceDetails,
  AquiferResourceMediaType,
  AquiferResourceSearchItem,
  AquiferResourceType,
} from '@/lib/services/aquifer/aquifer.types';
import type { Result } from '@/lib/types';

import { getResource, searchAllResources } from '@/lib/services/aquifer/aquifer.client';
import { ok } from '@/lib/types';

import type {
  PrepareOfflineManifestItem,
  PrepareOfflineManifestResponse,
  TranslationImagesResponse,
  TranslationNotesResponse,
  TranslationQuestionsResponse,
} from './translation-resources.types';

export const AQUIFER_RESOURCE_COLLECTIONS = {
  translationNotes: 'UWTranslationNotes',
  translationWords: 'UWTranslationWords',
  translationQuestions: 'UWTranslationQuestions',
} as const;

interface ResourceSearchConfig {
  tier: 1 | 2 | 3;
  resourceName: string;
  required: boolean;
  collectionCode?: string;
  resourceType?: AquiferResourceType;
}

/**
 * Same catalog mobile Prepare Offline already searches via Aquifer directly
 * (see fluent-mobile prepareOfflineResourceManifest.ts) — excluding Bible text
 * which remains a Fluent/DBL concern.
 */
const MANIFEST_SEARCH_CONFIGS: ResourceSearchConfig[] = [
  {
    tier: 2,
    resourceName: 'Translation Notes',
    required: true,
    collectionCode: AQUIFER_RESOURCE_COLLECTIONS.translationNotes,
  },
  {
    tier: 2,
    resourceName: 'Translation Words',
    required: false,
    collectionCode: AQUIFER_RESOURCE_COLLECTIONS.translationWords,
  },
  {
    tier: 2,
    resourceName: 'Translation Questions',
    required: false,
    collectionCode: AQUIFER_RESOURCE_COLLECTIONS.translationQuestions,
  },
  {
    tier: 3,
    resourceName: 'Bible Commentary',
    required: false,
    resourceType: 'StudyNotes',
  },
  {
    tier: 3,
    resourceName: 'Reference Images',
    required: false,
    resourceType: 'Images',
  },
];

interface VerseRef {
  bookCode: string;
  chapter: number;
  verse: number;
  languageCode: string;
}

interface ChapterRange {
  bookCode: string;
  startChapter: number;
  endChapter: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstStringField(value: unknown, fieldName: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value[fieldName];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  for (const child of Object.values(value)) {
    const found = firstStringField(child, fieldName);
    if (found) return found;
  }
  return undefined;
}

function firstNumberField(value: unknown, fieldName: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value[fieldName];
  if (typeof direct === 'number') {
    return direct;
  }
  for (const child of Object.values(value)) {
    const found = firstNumberField(child, fieldName);
    if (found !== undefined) return found;
  }
  return undefined;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonByteLength(value: unknown): { json: string; bytes: number } {
  const json = JSON.stringify(value);
  return { json, bytes: utf8ByteLength(json) };
}

function fileExtFromUrl(url: string, fallback: string): string {
  const clean = url.split('?')[0] ?? url;
  const ext = clean.split('.').pop()?.toLowerCase();
  return ext && /^[a-z0-9]+$/.test(ext) ? ext : fallback;
}

function kindForMediaType(mediaType: AquiferResourceMediaType): PrepareOfflineManifestItem['kind'] {
  if (mediaType === 'Audio') return 'audio';
  if (mediaType === 'Image') return 'image';
  return 'text';
}

function mediaFallbackExt(mediaType: AquiferResourceMediaType): string {
  if (mediaType === 'Audio') return 'mp3';
  if (mediaType === 'Image') return 'jpg';
  return 'json';
}

async function hydrateTextItems(
  searchItems: AquiferResourceSearchItem[]
): Promise<Result<Array<{ id: number; name: string; localizedName: string; content: unknown }>>> {
  const items: Array<{ id: number; name: string; localizedName: string; content: unknown }> = [];

  for (const hit of searchItems) {
    const details = await getResource(hit.id);
    if (!details.ok) return details;
    items.push({
      id: hit.id,
      name: hit.name,
      localizedName: hit.localizedName,
      content: details.data.content,
    });
  }

  return ok(items);
}

async function searchVerseCollection(
  ref: VerseRef,
  resourceCollectionCode: string
): Promise<Result<AquiferResourceSearchItem[]>> {
  return searchAllResources({
    bookCode: ref.bookCode,
    startChapter: ref.chapter,
    endChapter: ref.chapter,
    startVerse: ref.verse,
    endVerse: ref.verse,
    languageCode: ref.languageCode,
    resourceCollectionCode,
  });
}

/**
 * Translation Notes for a single verse — empty `items` when Aquifer has none.
 */
export async function getTranslationNotes(
  ref: VerseRef
): Promise<Result<TranslationNotesResponse>> {
  const search = await searchVerseCollection(ref, AQUIFER_RESOURCE_COLLECTIONS.translationNotes);
  if (!search.ok) return search;

  const hydrated = await hydrateTextItems(search.data);
  if (!hydrated.ok) return hydrated;

  return ok({ items: hydrated.data });
}

/**
 * Translation Questions for a single verse — TipTap preserved (Q/A split is UI-side).
 */
export async function getTranslationQuestions(
  ref: VerseRef
): Promise<Result<TranslationQuestionsResponse>> {
  const search = await searchVerseCollection(
    ref,
    AQUIFER_RESOURCE_COLLECTIONS.translationQuestions
  );
  if (!search.ok) return search;

  const hydrated = await hydrateTextItems(search.data);
  if (!hydrated.ok) return hydrated;

  return ok({ items: hydrated.data });
}

/**
 * Images & Maps for a single verse — hydrates details for URL / size.
 */
export async function getTranslationImages(
  ref: VerseRef
): Promise<Result<TranslationImagesResponse>> {
  const search = await searchAllResources({
    bookCode: ref.bookCode,
    startChapter: ref.chapter,
    endChapter: ref.chapter,
    startVerse: ref.verse,
    endVerse: ref.verse,
    languageCode: ref.languageCode,
    resourceType: 'Images',
  });
  if (!search.ok) return search;

  const items: TranslationImagesResponse['items'] = [];
  for (const hit of search.data) {
    const details = await getResource(hit.id);
    if (!details.ok) return details;

    const url = firstStringField(details.data.content, 'url');
    if (!url) continue;

    const size = firstNumberField(details.data.content, 'size');
    items.push({
      id: hit.id,
      title: hit.localizedName || hit.name,
      localizedName: hit.localizedName || hit.name,
      url,
      thumbnailUrl: url,
      size,
    });
  }

  return ok({ items });
}

function buildManifestItem(params: {
  config: ResourceSearchConfig;
  searchItem: AquiferResourceSearchItem;
  details: AquiferResourceDetails;
  languageCode: string;
  range: ChapterRange;
}): PrepareOfflineManifestItem {
  const { config, searchItem, details, languageCode, range } = params;
  const kind = kindForMediaType(searchItem.mediaType);
  const sourceUrl = kind === 'text' ? undefined : firstStringField(details.content, 'url');
  const serialized = kind === 'text' ? jsonByteLength(details) : undefined;
  const bytesTotal =
    kind === 'text' ? (serialized?.bytes ?? 0) : (firstNumberField(details.content, 'size') ?? 0);

  return {
    id: `aquifer-${searchItem.id}-${kind}`,
    tier: config.tier,
    kind,
    resourceName: config.resourceName,
    label: searchItem.localizedName || searchItem.name,
    required: config.required,
    removable: !config.required,
    bytesTotal,
    sourceUrl,
    fileExt: sourceUrl ? fileExtFromUrl(sourceUrl, mediaFallbackExt(searchItem.mediaType)) : 'json',
    aquiferContentId: searchItem.id,
    languageCode,
    bookCode: range.bookCode,
    startChapter: range.startChapter,
    endChapter: range.endChapter,
    collectionCode: config.collectionCode ?? searchItem.grouping.collectionCode,
    resourceType: config.resourceType ?? searchItem.grouping.type,
    serializedContent: serialized?.json,
  };
}

/**
 * Full Prepare Offline resource manifest for a book chapter range.
 * Includes TN, TW, TQ, StudyNotes, and Images (mobile Aquifer offline catalog).
 */
export async function getPrepareOfflineManifest(params: {
  projectId: number;
  languageCode: string;
  bookCode: string;
  startChapter: number;
  endChapter: number;
}): Promise<Result<PrepareOfflineManifestResponse>> {
  const { projectId, languageCode, bookCode, startChapter, endChapter } = params;
  const range: ChapterRange = { bookCode, startChapter, endChapter };
  const items: PrepareOfflineManifestItem[] = [];

  for (const config of MANIFEST_SEARCH_CONFIGS) {
    const search = await searchAllResources({
      bookCode,
      startChapter,
      endChapter,
      startVerse: 1,
      endVerse: 200,
      languageCode,
      resourceCollectionCode: config.collectionCode,
      resourceType: config.resourceType,
    });
    if (!search.ok) return search;

    for (const searchItem of search.data) {
      const details = await getResource(searchItem.id);
      if (!details.ok) return details;

      items.push(
        buildManifestItem({
          config,
          searchItem,
          details: details.data,
          languageCode,
          range,
        })
      );
    }
  }

  const totalBytes = items.reduce((sum, item) => sum + item.bytesTotal, 0);

  return ok({
    projectId,
    sourceLanguageCode: languageCode,
    items,
    totalBytes,
  });
}
