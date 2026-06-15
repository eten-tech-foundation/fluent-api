import { eq, inArray } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { bible_books, bibles, books, languages } from '@/db/schema';

const IRV_BIBLE = {
  name: 'IRV Gujarati',
  abbreviation: 'IRV',
  languageCode: 'guj',
} as const;

const IRV_BOOK_CODES = ['GEN', 'EXO'] as const;

export async function seedBibles() {
  // 1. Resolve the Gujarati language.
  const [language] = await db
    .select({ id: languages.id })
    .from(languages)
    .where(eq(languages.langCodeIso6393, IRV_BIBLE.languageCode))
    .limit(1);

  if (!language) {
    throw new Error(`Language "${IRV_BIBLE.languageCode}" not found. Run seedLanguages first.`);
  }

  // 2. Insert the bible (idempotent via unique abbreviation).
  await db
    .insert(bibles)
    .values({
      name: IRV_BIBLE.name,
      abbreviation: IRV_BIBLE.abbreviation,
      languageId: language.id,
    })
    .onConflictDoNothing({ target: bibles.abbreviation });

  const [bible] = await db
    .select({ id: bibles.id })
    .from(bibles)
    .where(eq(bibles.abbreviation, IRV_BIBLE.abbreviation))
    .limit(1);

  if (!bible) {
    throw new Error('IRV bible not found after insert.');
  }

  // 3. Resolve GEN + EXO book ids.
  const bookRows = await db
    .select({ id: books.id, code: books.code })
    .from(books)
    .where(inArray(books.code, [...IRV_BOOK_CODES]));

  if (bookRows.length !== IRV_BOOK_CODES.length) {
    const found = new Set(bookRows.map((b) => b.code));
    const missing = IRV_BOOK_CODES.filter((c) => !found.has(c));
    throw new Error(`Book(s) not found: ${missing.join(', ')}. Run seedBooks first.`);
  }

  // 4. Link bible -> books (idempotent; table has no unique constraint).
  const existingLinks = await db
    .select({ bookId: bible_books.bookId })
    .from(bible_books)
    .where(eq(bible_books.bibleId, bible.id));
  const linkedBookIds = new Set(existingLinks.map((l) => l.bookId));

  const linksToInsert = bookRows
    .filter((b) => !linkedBookIds.has(b.id))
    .map((b) => ({ bibleId: bible.id, bookId: b.id }));

  if (linksToInsert.length > 0) {
    await db.insert(bible_books).values(linksToInsert);
  }

  console.log(`Bibles seeded. (IRV id=${bible.id}, ${linksToInsert.length} new book link(s))`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedBibles()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
