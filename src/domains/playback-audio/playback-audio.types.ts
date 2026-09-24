import { z } from '@hono/zod-openapi';

import { parseBibleKey } from '@/domains/bible-provider-resources/identity';
import { ttsLicenseStatusSchema } from '@/domains/bibles/bibles.types';
import {
  sourceAudioItemSchema,
  sourceAudioResponseSchema,
} from '@/domains/source-audio/source-audio.types';

export const bibleKeySchema = z
  .string()
  .refine((value) => parseBibleKey(value) !== null, 'Invalid Bible identity');
export const resourceFactsSchema = z.object({
  bibleKey: bibleKeySchema,
  id: z.number().int().nullable(),
  provider: z.enum(['aquifer', 'youversion', 'dbl']),
  externalId: z.string(),
  ttsLicenseStatus: ttsLicenseStatusSchema,
  licenseNotice: z.string().nullable(),
});
export const playbackAudioResponseSchema = sourceAudioResponseSchema.extend({
  provider: z.enum(['aquifer', 'youversion', 'dbl']),
  textBibleKey: bibleKeySchema.nullable(),
  selectedRecordingKey: bibleKeySchema.nullable(),
  ttsLicenseStatus: ttsLicenseStatusSchema,
  verseAddressable: z.boolean(),
  items: z.array(
    sourceAudioItemSchema.extend({
      recordingKey: bibleKeySchema,
      licenseNotice: z.string().nullable(),
      trackId: z.string().optional(),
    })
  ),
  verseTimestamps: z
    .array(
      z.object({
        verse: z.number().int().positive(),
        startSeconds: z.number().nonnegative(),
        endSeconds: z.number().nonnegative().optional(),
        dblAudioBibleId: z.string().optional(),
      })
    )
    .optional(),
});
export type PlaybackAudioResponse = z.infer<typeof playbackAudioResponseSchema>;
