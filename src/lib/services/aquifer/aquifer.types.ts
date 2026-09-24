import type { JSONValue } from 'hono/utils/types';

import { z } from '@hono/zod-openapi';

const KNOWN_RESOURCE_TYPES = [
  'None',
  'Guide',
  'Dictionary',
  'StudyNotes',
  'Images',
  'Videos',
] as const;

const KNOWN_MEDIA_TYPES = ['None', 'Text', 'Audio', 'Video', 'Image'] as const;

/**
 * Accept known Aquifer enums; fall back to the raw string for unknown upstream
 * values so search payloads are not rejected on Aquifer drift.
 */
export const aquiferResourceTypeSchema = z.union([z.enum(KNOWN_RESOURCE_TYPES), z.string()]);

export type AquiferResourceType = (typeof KNOWN_RESOURCE_TYPES)[number] | string;

export const aquiferResourceMediaTypeSchema = z.union([z.enum(KNOWN_MEDIA_TYPES), z.string()]);

export type AquiferResourceMediaType = (typeof KNOWN_MEDIA_TYPES)[number] | string;

export const aquiferResourceSearchItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  localizedName: z.string(),
  mediaType: aquiferResourceMediaTypeSchema,
  languageCode: z.string(),
  grouping: z.object({
    type: aquiferResourceTypeSchema,
    name: z.string(),
    collectionTitle: z.string().optional(),
    collectionCode: z.string().optional(),
  }),
});

export type AquiferResourceSearchItem = z.infer<typeof aquiferResourceSearchItemSchema>;

export const aquiferResourceSearchResponseSchema = z.object({
  totalItemCount: z.number().int(),
  returnedItemCount: z.number().int(),
  offset: z.number().int(),
  items: z.array(aquiferResourceSearchItemSchema),
});

export type AquiferResourceSearchResponse = z.infer<typeof aquiferResourceSearchResponseSchema>;

// One wire model for online resources and offline manifests. Known fields are optional to
// tolerate partial upstream metadata; unknown keys survive, including nested attribution fields.
const aquiferLicenseLinkSchema = z
  .object({
    name: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

export const aquiferLicenseInfoSchema = z
  .object({
    title: z.string().optional(),
    copyright: z
      .object({
        dates: z.string().optional(),
        holder: aquiferLicenseLinkSchema.optional(),
      })
      .passthrough()
      .optional(),
    licenses: z.array(z.record(aquiferLicenseLinkSchema)).optional(),
    showAdaptationNoticeForEnglish: z.boolean().optional(),
    showAdaptationNoticeForNonEnglish: z.boolean().optional(),
  })
  .passthrough();

// Attribution must not make an otherwise usable resource disappear on provider drift.
// Keep the known model available to renderers, but preserve the raw notice on an unexpected
// shape rather than rejecting the resource or silently discarding its licence information.
export const aquiferLicenseInfoWireSchema = z.union([aquiferLicenseInfoSchema, z.unknown()]);

/**
 * Details payload — `content` is TipTap (text) or nested media objects (images).
 * Kept loose so we do not reject Aquifer shape drift; callers walk it as needed.
 */
export const aquiferResourceDetailsSchema = z
  .object({
    id: z.number().int(),
    referenceId: z.number().int().optional(),
    name: z.string(),
    localizedName: z.string(),
    content: z.custom<JSONValue>(),
    grouping: z
      .object({
        type: aquiferResourceTypeSchema.optional(),
        name: z.string().optional(),
        mediaType: z.string().optional(),
        licenseInfo: aquiferLicenseInfoWireSchema.optional(),
        collectionCode: z.string().optional(),
      })
      .passthrough(),
    language: z
      .object({
        id: z.number().int().optional(),
        code: z.string().optional(),
        displayName: z.string().optional(),
        scriptDirection: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .openapi('AquiferResourceDetails');

export type AquiferResourceDetails = z.infer<typeof aquiferResourceDetailsSchema>;

export interface AquiferSearchResourcesParams {
  bookCode: string;
  startChapter: number;
  endChapter: number;
  languageCode: string;
  startVerse?: number;
  endVerse?: number;
  resourceType?: AquiferResourceType;
  resourceCollectionCode?: string;
  limit?: number;
  offset?: number;
}

export const aquiferMediaFileSchema = z.object({
  url: z.string(),
  size: z.number().int().nonnegative().nullish(),
});

export type AquiferMediaFile = z.infer<typeof aquiferMediaFileSchema>;

export const aquiferBibleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  abbreviation: z.string(),
  languageId: z.number().int().optional(),
  languageCode: z.string().optional(),
  isLanguageDefault: z.boolean().optional(),
  hasAudio: z.boolean().optional(),
});

export type AquiferBible = z.infer<typeof aquiferBibleSchema>;

export const aquiferBibleTextChapterSchema = z.object({
  number: z.number().int(),
  audio: z
    .object({
      webm: aquiferMediaFileSchema.nullable().optional(),
      mp3: aquiferMediaFileSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
  verses: z.array(
    z.object({
      number: z.number().int(),
      text: z.string().nullish(),
      audioTimestamp: z.unknown().optional(),
    })
  ),
});

export const aquiferBibleTextResponseSchema = z.object({
  bibleId: z.number().int(),
  bibleName: z.string(),
  bibleAbbreviation: z.string(),
  bookName: z.string(),
  bookCode: z.string(),
  chapters: z.array(aquiferBibleTextChapterSchema),
});

export type AquiferBibleTextResponse = z.infer<typeof aquiferBibleTextResponseSchema>;

export const aquiferLanguageSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  englishDisplay: z.string(),
  localizedDisplay: z.string(),
  scriptDirection: z.string(),
});

export type AquiferLanguage = z.infer<typeof aquiferLanguageSchema>;

export const aquiferAvailableLanguageSchema = z.object({
  languageId: z.number().int(),
  languageCode: z.string(),
  displayName: z.string(),
  resourceItemCount: z.number().int(),
});

export type AquiferAvailableLanguage = z.infer<typeof aquiferAvailableLanguageSchema>;

export const aquiferResourceCollectionSchema = z.object({
  code: z.string(),
  displayName: z.string(),
  availableLanguages: z.array(aquiferAvailableLanguageSchema),
});

export type AquiferResourceCollection = z.infer<typeof aquiferResourceCollectionSchema>;

export const aquiferLanguageResourceCountSchema = z.object({
  languageId: z.number().int(),
  languageCode: z.string(),
  resourceCounts: z.array(
    z.object({
      type: z.string(),
      count: z.number().int(),
    })
  ),
});

export type AquiferLanguageResourceCount = z.infer<typeof aquiferLanguageResourceCountSchema>;

export interface AquiferAvailableResourcesParams {
  bookCode: string;
  startChapter: number;
  endChapter: number;
  startVerse?: number;
  endVerse?: number;
}

export const aquiferPassageAssociationSchema = z.object({
  startBookCode: z.string(),
  startChapter: z.number().int(),
  startVerse: z.number().int(),
  endBookCode: z.string(),
  endChapter: z.number().int(),
  endVerse: z.number().int(),
});

export const aquiferResourceAssociationItemSchema = z.object({
  referenceId: z.number().int(),
  contentId: z.number().int(),
});

export const aquiferAssociationResponseSchema = z.object({
  resourceAssociations: z.array(aquiferResourceAssociationItemSchema).optional(),
  passageAssociations: z.array(aquiferPassageAssociationSchema).optional(),
});

export type AquiferAssociationResponse = z.infer<typeof aquiferAssociationResponseSchema>;
