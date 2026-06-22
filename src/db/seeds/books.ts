import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { books } from '@/db/schema';

interface BookRecord {
  code: string;
  eng_display_name: string;
}

function loadBooks(): BookRecord[] {
  const raw = readFileSync(new URL('./data/books.json', import.meta.url), 'utf-8');
  return (JSON.parse(raw) as { books: BookRecord[] }).books;
}

export async function seedBooks() {
  const records = loadBooks();

  const existing = await db.select({ code: books.code }).from(books);
  const existingCodes = new Set(existing.map((r) => r.code));

  const toInsert = records
    .filter((r) => !existingCodes.has(r.code))
    .map((r) => ({ code: r.code, eng_display_name: r.eng_display_name }));

  if (toInsert.length > 0) {
    await db.insert(books).values(toInsert);
  }

  console.log(
    `Books seeded. (${toInsert.length} new, ${records.length - toInsert.length} skipped)`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedBooks()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
