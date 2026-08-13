import { z } from '@hono/zod-openapi';

/** Aquifer resource grouping / type codes used in search and details. */
export const aquiferResourceTypeSchema = z.enum([
  'None',
  'Guide',
  'Dictionary',
  'StudyNotes',
  'Images',
  'Videos',
]);

export type AquiferResourceType = z.infer<typeof aquiferResourceTypeSchema>;

export const aquiferResourceMediaTypeSchema = z.enum(['None', 'Text', 'Audio', 'Video', 'Image']);

export type AquiferResourceMediaType = z.infer<typeof aquiferResourceMediaTypeSchema>;

export const aquiferResourceSearchItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  localizedName: z.string(),
  mediaType: aquiferResourceMediaTypeSchema,
  languageCode: z.string(),
  grouping: z.object({
    type: aquiferResourceTypeSchema,
    name: z.string(),
    collectionTitle: z.string(),
    collectionCode: z.string(),
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

/**
 * Details payload — `content` is TipTap (text) or nested media objects (images).
 * Kept loose so we do not reject Aquifer shape drift; callers walk it as needed.
 */
export const aquiferResourceDetailsSchema = z.object({
  id: z.number().int(),
  referenceId: z.number().int().optional(),
  name: z.string(),
  localizedName: z.string(),
  content: z.unknown(),
  grouping: z
    .object({
      type: aquiferResourceTypeSchema.optional(),
      name: z.string().optional(),
      mediaType: z.string().optional(),
      licenseInfo: z.unknown().optional(),
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
});

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
