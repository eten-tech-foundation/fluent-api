import { eq, isNull, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { books, pericope_sets, pericope_verses, projects } from '@/db/schema';

const CHUNK_SIZE = 500;

// ─── Source file paths (relative to project root) ─────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');

// ─── Raw JSON shapes ───────────────────────────────────────────────────────────

interface FcbhRecord {
  book: string;
  chapter: number;
  verse: number;
  fcbh_section: number;
  fcbh_pericope_number: number;
}

interface FiaRecord {
  book: string;
  chapter: number;
  verse: number;
  fia_pericope_number: string;
  fia_pericope_title: string | null;
}

// ─── Normalised insert shape ───────────────────────────────────────────────────

interface PericopeVerseInsert {
  pericopeSetId: number;
  bookId: number;
  chapterNumber: number;
  verseNumber: number;
  section: number | null;
  pericopeNumber: string;
  pericopeTitle: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadJson<T>(filename: string): T {
  const raw = readFileSync(path.join(DATA_DIR, filename), 'utf-8');
  return JSON.parse(raw) as T;
}

/** Build a Map of eng_display_name → book.id from the current DB. */
async function buildBookIdMap(): Promise<Map<string, number>> {
  const rows = await db.select({ id: books.id, name: books.eng_display_name }).from(books);
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.name, row.id);
  }
  return map;
}

/** Upsert a pericope set by name; return its id. */
async function upsertPericopeSet(name: string, description: string): Promise<number> {
  const [inserted] = await db
    .insert(pericope_sets)
    .values({ name, description })
    .onConflictDoUpdate({
      target: pericope_sets.name,
      set: { description },
    })
    .returning({ id: pericope_sets.id });

  return inserted.id;
}

/** Delete all existing verse rows for a set, then batch-insert new ones. */
async function replaceVerses(setId: number, rows: PericopeVerseInsert[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(pericope_verses).where(eq(pericope_verses.pericopeSetId, setId));

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await tx.insert(pericope_verses).values(rows.slice(i, i + CHUNK_SIZE));
    }
  });
}

// ─── Per-set seeders ──────────────────────────────────────────────────────────

async function seedFcbh(bookIdMap: Map<string, number>): Promise<void> {
  console.log('Seeding FCBH...');

  const records = loadJson<FcbhRecord[]>('FCBH-All-Books.json');
  const setId = await upsertPericopeSet('FCBH', 'Faith Comes By Hearing');

  const unmappedBooks = new Set<string>();
  const rows: PericopeVerseInsert[] = [];

  for (const r of records) {
    const bookId = bookIdMap.get(r.book);
    if (!bookId) {
      unmappedBooks.add(r.book);
      continue;
    }
    rows.push({
      pericopeSetId: setId,
      bookId,
      chapterNumber: r.chapter,
      verseNumber: r.verse,
      section: r.fcbh_section,
      pericopeNumber: String(r.fcbh_pericope_number),
      pericopeTitle: null, // FCBH has no titles
    });
  }

  if (unmappedBooks.size > 0) {
    console.warn(`FCBH: skipped ${unmappedBooks.size} unknown book(s): ${[...unmappedBooks].join(', ')}`);
  }

  await replaceVerses(setId, rows);
  console.log(`FCBH seeded. (${rows.length} verse rows)`);
}

async function seedFia(bookIdMap: Map<string, number>): Promise<void> {
  console.log('Seeding FIA...');

  const records = loadJson<FiaRecord[]>('FIA-All-Books.json');
  const setId = await upsertPericopeSet('FIA', 'Forum of International Advisors');

  const unmappedBooks = new Set<string>();
  const rows: PericopeVerseInsert[] = [];

  for (const r of records) {
    const bookId = bookIdMap.get(r.book);
    if (!bookId) {
      unmappedBooks.add(r.book);
      continue;
    }
    rows.push({
      pericopeSetId: setId,
      bookId,
      chapterNumber: r.chapter,
      verseNumber: r.verse,
      section: null, // FIA has no section
      pericopeNumber: r.fia_pericope_number,
      pericopeTitle: r.fia_pericope_title ?? null,
    });
  }

  if (unmappedBooks.size > 0) {
    console.warn(`FIA: skipped ${unmappedBooks.size} unknown book(s): ${[...unmappedBooks].join(', ')}`);
  }

  await replaceVerses(setId, rows);
  console.log(`FIA seeded. (${rows.length} verse rows)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function seedPericopeSets(): Promise<void> {
  const bookIdMap = await buildBookIdMap();

  if (bookIdMap.size === 0) {
    throw new Error('No books found in DB. Run seedBooks first.');
  }

  await seedFcbh(bookIdMap);
  await seedFia(bookIdMap);

  // Auto-assign existing projects that lack a pericope set to FIA by default
  const [fiaSet] = await db
    .select({ id: pericope_sets.id })
    .from(pericope_sets)
    //to change the old existing projects//
    .where(eq(pericope_sets.name, 'FIA'))
    .limit(1);

  if (fiaSet) {
    await db
      .update(projects)
      .set({ pericopeSetId: fiaSet.id })
      .where(isNull(projects.pericopeSetId));
    console.log('Auto-assigned FIA pericope set to all projects without one.');
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(pericope_verses);

  console.log(`Done. Total pericope_verses rows: ${count}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedPericopeSets()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
