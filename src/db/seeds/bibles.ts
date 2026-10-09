import { and, eq, inArray } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { bible_books, bible_provider_resources, bibles, books, languages } from '@/db/schema';

const IRV_BIBLE = {
  name: 'IRV Gujarati',
  abbreviation: 'IRV',
  languageCode: 'guj',
} as const;

const IRV_BOOK_CODES = ['GEN', 'EXO'] as const;

// Offline text fixture is DBL BSB; its explicitly selected recording is Aquifer BSB.
const BSB_BIBLE = {
  name: 'Berean Standard Bible',
  abbreviation: 'BSB',
  languageCode: 'eng',
  externalId: 'bba9f40183526463-01',
} as const;

const BSB_BOOK_CODES = ['JHN'] as const;

export async function seedBibles() {
  await seedIrvGujarati();
  await seedBereanStandardBible();
}

async function seedIrvGujarati() {
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

  // books.code is not unique at the schema level, so inArray can return more than
  // one row per code. Dedupe by code (failing fast on duplicates) so a duplicated
  // book never produces two bible_books links for the same logical book.
  const idByCode = new Map<string, number>();
  const duplicateCodes = new Set<string>();
  for (const row of bookRows) {
    if (idByCode.has(row.code)) {
      duplicateCodes.add(row.code);
      continue;
    }
    idByCode.set(row.code, row.id);
  }
  if (duplicateCodes.size > 0) {
    throw new Error(
      `Duplicate books.code detected: ${[...duplicateCodes].join(', ')}. ` +
        'Deduplicate books before running seedBibles.'
    );
  }

  const missing = IRV_BOOK_CODES.filter((c) => !idByCode.has(c));
  if (missing.length > 0) {
    throw new Error(`Book(s) not found: ${missing.join(', ')}. Run seedBooks first.`);
  }

  // 4. Link bible -> books (idempotent; table has no unique constraint).
  const existingLinks = await db
    .select({ bookId: bible_books.bookId })
    .from(bible_books)
    .where(eq(bible_books.bibleId, bible.id));
  const linkedBookIds = new Set(existingLinks.map((l) => l.bookId));

  const linksToInsert = IRV_BOOK_CODES.map((code) => idByCode.get(code) as number)
    .filter((bookId) => !linkedBookIds.has(bookId))
    .map((bookId) => ({ bibleId: bible.id, bookId }));

  if (linksToInsert.length > 0) {
    await db.insert(bible_books).values(linksToInsert);
  }

  console.log(`Bibles seeded. (IRV id=${bible.id}, ${linksToInsert.length} new book link(s))`);
}

/**
 * English BSB, pinned to its Aquifer publication so the source-audio path is exercisable.
 * Deliberately additive: it never touches the IRV row above.
 */
async function seedBereanStandardBible() {
  await db
    .insert(bible_provider_resources)
    .values([
      {
        provider: 'dbl',
        externalId: BSB_BIBLE.externalId,
        ttsLicenseStatus: 'allowed',
        displayName: BSB_BIBLE.name,
      },
      {
        provider: 'aquifer',
        externalId: '1',
        ttsLicenseStatus: 'allowed',
        licenseNotice: 'Berean Standard Bible (BSB). Public domain.',
        displayName: BSB_BIBLE.name,
      },
    ])
    .onConflictDoNothing();
  const [recording] = await db
    .select()
    .from(bible_provider_resources)
    .where(
      and(
        eq(bible_provider_resources.provider, 'aquifer'),
        eq(bible_provider_resources.externalId, '1')
      )
    );
  if (!recording) throw new Error('Aquifer BSB recording resource missing');

  const [language] = await db
    .select({ id: languages.id })
    .from(languages)
    .where(eq(languages.langCodeIso6393, BSB_BIBLE.languageCode))
    .limit(1);

  if (!language) {
    throw new Error(`Language "${BSB_BIBLE.languageCode}" not found. Run seedLanguages first.`);
  }

  await db
    .insert(bibles)
    .values({
      name: BSB_BIBLE.name,
      abbreviation: BSB_BIBLE.abbreviation,
      languageId: language.id,
      provider: 'dbl',
      externalId: BSB_BIBLE.externalId,
      audioResourceId: recording.id,
    })
    .onConflictDoNothing({ target: bibles.abbreviation });

  const [bible] = await db
    .select({ id: bibles.id })
    .from(bibles)
    .where(eq(bibles.abbreviation, BSB_BIBLE.abbreviation))
    .limit(1);

  if (!bible) {
    throw new Error('BSB bible not found after insert.');
  }

  const bookRows = await db
    .select({ id: books.id, code: books.code })
    .from(books)
    .where(inArray(books.code, [...BSB_BOOK_CODES]));

  const idByCode = new Map<string, number>();
  for (const row of bookRows) {
    if (!idByCode.has(row.code)) idByCode.set(row.code, row.id);
  }

  const missing = BSB_BOOK_CODES.filter((c) => !idByCode.has(c));
  if (missing.length > 0) {
    throw new Error(`Book(s) not found: ${missing.join(', ')}. Run seedBooks first.`);
  }

  const existingLinks = await db
    .select({ bookId: bible_books.bookId })
    .from(bible_books)
    .where(eq(bible_books.bibleId, bible.id));
  const linkedBookIds = new Set(existingLinks.map((l) => l.bookId));

  const linksToInsert = BSB_BOOK_CODES.map((code) => idByCode.get(code) as number)
    .filter((bookId) => !linkedBookIds.has(bookId))
    .map((bookId) => ({ bibleId: bible.id, bookId }));

  if (linksToInsert.length > 0) {
    await db.insert(bible_books).values(linksToInsert);
  }

  console.log(
    `Bibles seeded. (BSB id=${bible.id}, audioResourceId=${recording.id}, ` +
      `${linksToInsert.length} new book link(s))`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedBibles()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
