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

/** Parallel getResource calls when hydrating search hits. */
const HYDRATE_CONCURRENCY = 5;
/** Max hydrated items kept per MANIFEST_SEARCH_CONFIGS entry. */
const MAX_MANIFEST_ITEMS_PER_CONFIG = 100;
/**
 * Aquifer end-verse window for chapter-range searches. Chapters never exceed
 * this verse count; mirrors fluent-mobile Prepare Offline (1–200).
 */
const CHAPTER_RANGE_END_VERSE = 200;

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
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = firstStringField(child, fieldName);
      if (found) return found;
    }
    return undefined;
  }
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
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = firstNumberField(child, fieldName);
      if (found !== undefined) return found;
    }
    return undefined;
  }
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

/**
 * Map items with a fixed concurrency pool. Individual mapper failures are
 * skipped so one bad Aquifer content id cannot drop the rest of the section.
 * If every item fails, the first failure is returned so the route can 502
 * instead of looking like an empty collection.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<Result<R>>
): Promise<Result<R[]>> {
  if (items.length === 0) return ok([]);

  const slots: Array<Result<R> | undefined> = Array.from({ length: items.length });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      slots[current] = await mapper(items[current]!);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const successes: R[] = [];
  let firstFailure: Extract<Result<never>, { ok: false }> | undefined;
  for (const slot of slots) {
    if (!slot) continue;
    if (slot.ok) successes.push(slot.data);
    else firstFailure ??= slot;
  }

  if (successes.length === 0 && firstFailure) return firstFailure;
  return ok(successes);
}

function firstAssetUrl(content: unknown): string | undefined {
  return firstStringField(content, 'url') ?? firstStringField(content, 'href');
}

async function hydrateTextItems(
  searchItems: AquiferResourceSearchItem[]
): Promise<Result<Array<{ id: number; name: string; localizedName: string; content: unknown }>>> {
  return mapWithConcurrency(searchItems, HYDRATE_CONCURRENCY, async (hit) => {
    const details = await getResource(hit.id);
    if (!details.ok) return details;
    return ok({
      id: hit.id,
      name: hit.name,
      localizedName: hit.localizedName,
      content: details.data.content,
    });
  });
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

  const hydrated = await mapWithConcurrency(search.data, HYDRATE_CONCURRENCY, async (hit) => {
    const details = await getResource(hit.id);
    if (!details.ok) return details;
    return ok({ hit, details: details.data });
  });
  if (!hydrated.ok) return hydrated;

  const items: TranslationImagesResponse['items'] = [];
  for (const { hit, details } of hydrated.data) {
    const url = firstAssetUrl(details.content);
    if (!url) continue;

    const size = firstNumberField(details.content, 'size');
    const thumbnailUrl = firstStringField(details.content, 'thumbnailUrl');
    items.push({
      id: hit.id,
      title: hit.localizedName || hit.name,
      localizedName: hit.localizedName || hit.name,
      url,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
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
  includeContent: boolean;
}): PrepareOfflineManifestItem {
  const { config, searchItem, details, languageCode, range, includeContent } = params;
  const kind = kindForMediaType(searchItem.mediaType);
  const sourceUrl = kind === 'text' ? undefined : firstAssetUrl(details.content);
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
    ...(includeContent && serialized ? { serializedContent: serialized.json } : {}),
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
  includeContent?: boolean;
}): Promise<Result<PrepareOfflineManifestResponse>> {
  const {
    projectId,
    languageCode,
    bookCode,
    startChapter,
    endChapter,
    includeContent = false,
  } = params;
  const range: ChapterRange = { bookCode, startChapter, endChapter };
  const items: PrepareOfflineManifestItem[] = [];
  let truncated = false;

  for (const config of MANIFEST_SEARCH_CONFIGS) {
    const search = await searchAllResources({
      bookCode,
      startChapter,
      endChapter,
      startVerse: 1,
      endVerse: CHAPTER_RANGE_END_VERSE,
      languageCode,
      resourceCollectionCode: config.collectionCode,
      resourceType: config.resourceType,
    });
    if (!search.ok) return search;

    if (search.data.length > MAX_MANIFEST_ITEMS_PER_CONFIG) {
      truncated = true;
    }
    const capped = search.data.slice(0, MAX_MANIFEST_ITEMS_PER_CONFIG);

    const hydrated = await mapWithConcurrency(capped, HYDRATE_CONCURRENCY, async (searchItem) => {
      const details = await getResource(searchItem.id);
      if (!details.ok) return details;
      return ok({ searchItem, details: details.data });
    });
    if (!hydrated.ok) return hydrated;

    for (const { searchItem, details } of hydrated.data) {
      items.push(
        buildManifestItem({
          config,
          searchItem,
          details,
          languageCode,
          range,
          includeContent,
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
    truncated,
  });
}
