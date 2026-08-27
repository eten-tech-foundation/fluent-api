import { z } from '@hono/zod-openapi';

export const bibleAudioResponseSchema = z.object({
  audioBibleId: z.string().openapi({ example: '12345' }),
  name: z.string().openapi({ example: 'Estonian Contemporary Audio' }),
  chapterId: z.string().openapi({ example: 'GEN.1' }),
  resourceUrl: z.string().url().openapi({ example: 'https://example.com/audio.mp3' }),
  expiresAt: z.number().nullish().openapi({ example: 1672531200 }),
  timecodes: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
        verseId: z.string(),
      })
    )
    .nullish()
    .openapi({
      description: 'Optional timecodes mapping verse IDs to audio start/end timestamps',
      example: [{ start: '0.0', end: '4.5', verseId: 'GEN.1.1' }],
    }),
});

export type BibleAudioResponse = z.infer<typeof bibleAudioResponseSchema>;
