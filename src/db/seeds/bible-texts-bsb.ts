import { z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

import { db } from '@/db';
import { bible_texts, bibles, books } from '@/db/schema';

const bsbJohnSchema = z.object({
  source: z.object({ bookCode: z.literal('JHN'), license: z.literal('Public domain') }),
  verses: z
    .array(
      z.object({
        chapter: z.number().int().min(1).max(21),
        verse: z.number().int().positive(),
        text: z.string().min(1),
      })
    )
    .nonempty(),
});

// Captured from Aquifer on 2026-09-10; endpoint/date/notice are in the JSON header.
// Setup is offline: no API key, provider availability, or network call is needed to seed.
export function loadBsbJohn() {
  const raw = JSON.parse(readFileSync(new URL('./data/bsb-jhn.json', import.meta.url), 'utf-8'));
  return bsbJohnSchema.parse(raw).verses;
}

export async function seedBsbBibleTexts(): Promise<void> {
  const [bible] = await db
    .select({ id: bibles.id })
    .from(bibles)
    .where(eq(bibles.abbreviation, 'BSB'));
  const [book] = await db.select({ id: books.id }).from(books).where(eq(books.code, 'JHN'));
  if (!bible || !book) throw new Error('BSB/JHN not found. Run seedBibles and seedBooks first.');

  const rows = loadBsbJohn().map((verse) => ({
    bibleId: bible.id,
    bookId: book.id,
    chapterNumber: verse.chapter,
    verseNumber: verse.verse,
    text: verse.text,
  }));
  // Never reset verse IDs: translations may already reference them. Missing rows are filled
  // atomically on reruns; neither existing texts nor any translator work is overwritten.
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 500) {
      await tx
        .insert(bible_texts)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing({
          target: [
            bible_texts.bibleId,
            bible_texts.bookId,
            bible_texts.chapterNumber,
            bible_texts.verseNumber,
          ],
        });
    }
  });
  console.log(`BSB John texts seeded (${rows.length} source verses, existing rows retained).`);
}
