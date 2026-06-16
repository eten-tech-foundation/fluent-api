import { eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { bible_texts, bibles, books } from '@/db/schema';

const IRV_ABBREVIATION = 'IRV';
const CHUNK_SIZE = 1000;

interface BibleTextRecord {
  bible_id: number;
  book_id: number;
  chapter_number: number;
  verse_number: number;
  text: string;
}

interface BookRecord {
  code: string;
}

function loadBibleTexts(): BibleTextRecord[] {
  const raw = readFileSync(new URL('./data/bible-texts.json', import.meta.url), 'utf-8');
  return (JSON.parse(raw) as { bible_texts: BibleTextRecord[] }).bible_texts;
}

// PROD exports books in id order, so array index i => PROD book id (i + 1).
function loadBookCodeByProdId(): Map<number, string> {
  const raw = readFileSync(new URL('./data/books.json', import.meta.url), 'utf-8');
  const records = (JSON.parse(raw) as { books: BookRecord[] }).books;
  return new Map(records.map((b, i) => [i + 1, b.code]));
}

export async function seedBibleTexts() {
  // 1. Resolve the IRV bible.
  const [bible] = await db
    .select({ id: bibles.id })
    .from(bibles)
    .where(eq(bibles.abbreviation, IRV_ABBREVIATION))
    .limit(1);

  if (!bible) {
    throw new Error(`Bible "${IRV_ABBREVIATION}" not found. Run seedBibles first.`);
  }

  // 2. Load the expected corpus up front so the idempotency guard can compare counts.
  const records = loadBibleTexts();

  // 3. Idempotency guard: skip only when the full corpus is already present.
  // A bare "any rows exist" check would lock in a partial corpus left by a run
  // that failed mid-insert (step 6), so compare against the expected count.
  const [{ count: existingCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(bible_texts)
    .where(eq(bible_texts.bibleId, bible.id));

  if (Number(existingCount) === records.length) {
    console.log('Bible texts already seeded for IRV — skipping.');
    return;
  }

  // 4. Build PROD book_id -> local book id.
  const codeByProdBookId = loadBookCodeByProdId();
  const bookRows = await db.select({ id: books.id, code: books.code }).from(books);
  const localIdByCode = new Map(bookRows.map((b) => [b.code, b.id]));

  // 5. Remap rows to local ids.
  const rows = records.map((r) => {
    const code = codeByProdBookId.get(r.book_id);
    const localBookId = code ? localIdByCode.get(code) : undefined;
    if (!code || localBookId === undefined) {
      throw new Error(
        `Cannot map book_id ${r.book_id} (code=${code ?? 'unknown'}). Run seedBooks first.`
      );
    }
    return {
      bibleId: bible.id,
      bookId: localBookId,
      chapterNumber: r.chapter_number,
      verseNumber: r.verse_number,
      text: r.text,
    };
  });

  // 6. Atomically reset and bulk insert in chunks (stays well under Postgres
  // parameter limits). Clearing any partial rows inside the transaction keeps
  // reruns self-healing: each run lands the complete corpus or rolls back.
  await db.transaction(async (tx) => {
    if (Number(existingCount) > 0) {
      await tx.delete(bible_texts).where(eq(bible_texts.bibleId, bible.id));
    }
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await tx.insert(bible_texts).values(rows.slice(i, i + CHUNK_SIZE));
    }
  });

  console.log(`Bible texts seeded. (${rows.length} verses for IRV id=${bible.id})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedBibleTexts()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
