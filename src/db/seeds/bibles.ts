import { and, eq, inArray } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { bible_books, bible_provider_resources, bibles, books, languages } from '@/db/schema';

import { resolveBibleByIdentity } from './bible-identity';
import { BSB_BIBLE, BSB_BOOK_CODES, IRV_BIBLE, IRV_BOOK_CODES } from './reference-bibles';

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

  // 2. Provider-resource identities — the text row backs the TTS license
  // gate (bibleKey lookups), the audio row is the selected recording.
  await db
    .insert(bible_provider_resources)
    .values([
      {
        provider: 'dbl',
        externalId: IRV_BIBLE.externalId,
        ttsLicenseStatus: 'allowed',
        licenseNotice: IRV_BIBLE.licenseNotice,
        displayName: IRV_BIBLE.name,
      },
      {
        provider: 'dbl',
        externalId: IRV_BIBLE.audioExternalId,
        ttsLicenseStatus: 'allowed',
        licenseNotice: IRV_BIBLE.licenseNotice,
        displayName: `${IRV_BIBLE.name} audio`,
      },
    ])
    .onConflictDoNothing();

  const [recording] = await db
    .select()
    .from(bible_provider_resources)
    .where(
      and(
        eq(bible_provider_resources.provider, 'dbl'),
        eq(bible_provider_resources.externalId, IRV_BIBLE.audioExternalId)
      )
    );
  if (!recording) throw new Error('IRV audio recording resource missing');

  // 3. Resolve the bible row by upstream identity (see resolveBibleByIdentity)
  // and reconcile it, or create it fresh.
  const resolved = await resolveBibleByIdentity({
    abbreviation: IRV_BIBLE.abbreviation,
    name: IRV_BIBLE.name,
    externalId: IRV_BIBLE.externalId,
  });

  let bibleId: number;
  if (resolved.existing) {
    const bible = resolved.existing;
    bibleId = bible.id;
    const patch: { externalId?: string; hasAudio?: boolean; audioResourceId?: number } = {};
    if (bible.externalId !== IRV_BIBLE.externalId) patch.externalId = IRV_BIBLE.externalId;
    // A curated recording selection wins on rerun — only fill audio fields
    // when unset.
    if (bible.audioResourceId === null) {
      patch.hasAudio = true;
      patch.audioResourceId = recording.id;
    }
    if (Object.keys(patch).length) {
      await db.update(bibles).set(patch).where(eq(bibles.id, bible.id));
    }
  } else {
    const [bible] = await db
      .insert(bibles)
      .values({
        name: resolved.name,
        abbreviation: resolved.abbreviation,
        languageId: language.id,
        externalId: IRV_BIBLE.externalId,
        hasAudio: true,
        audioResourceId: recording.id,
      })
      .returning({ id: bibles.id });
    bibleId = bible.id;
  }

  // 4. Resolve GEN + EXO book ids.
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

  // 5. Link bible -> books (idempotent; table has no unique constraint).
  const existingLinks = await db
    .select({ bookId: bible_books.bookId })
    .from(bible_books)
    .where(eq(bible_books.bibleId, bibleId));
  const linkedBookIds = new Set(existingLinks.map((l) => l.bookId));

  const linksToInsert = IRV_BOOK_CODES.map((code) => idByCode.get(code) as number)
    .filter((bookId) => !linkedBookIds.has(bookId))
    .map((bookId) => ({ bibleId, bookId }));

  if (linksToInsert.length > 0) {
    await db.insert(bible_books).values(linksToInsert);
  }

  console.log(`Bibles seeded. (IRV id=${bibleId}, ${linksToInsert.length} new book link(s))`);
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

  // Same adopt/claim/suffix resolution as the IRV seed above.
  const resolved = await resolveBibleByIdentity({
    abbreviation: BSB_BIBLE.abbreviation,
    name: BSB_BIBLE.name,
    externalId: BSB_BIBLE.externalId,
  });

  let bibleId: number;
  if (resolved.existing) {
    const bible = resolved.existing;
    bibleId = bible.id;
    const patch: { externalId?: string; audioResourceId?: number } = {};
    if (bible.externalId !== BSB_BIBLE.externalId) patch.externalId = BSB_BIBLE.externalId;
    // A curated recording selection wins on rerun — only fill audio fields
    // when unset.
    if (bible.audioResourceId === null) patch.audioResourceId = recording.id;
    if (Object.keys(patch).length) {
      await db.update(bibles).set(patch).where(eq(bibles.id, bible.id));
    }
  } else {
    const [bible] = await db
      .insert(bibles)
      .values({
        name: resolved.name,
        abbreviation: resolved.abbreviation,
        languageId: language.id,
        provider: 'dbl',
        externalId: BSB_BIBLE.externalId,
        audioResourceId: recording.id,
      })
      .returning({ id: bibles.id });
    bibleId = bible.id;
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
    .where(eq(bible_books.bibleId, bibleId));
  const linkedBookIds = new Set(existingLinks.map((l) => l.bookId));

  const linksToInsert = BSB_BOOK_CODES.map((code) => idByCode.get(code) as number)
    .filter((bookId) => !linkedBookIds.has(bookId))
    .map((bookId) => ({ bibleId, bookId }));

  if (linksToInsert.length > 0) {
    await db.insert(bible_books).values(linksToInsert);
  }

  console.log(
    `Bibles seeded. (BSB id=${bibleId}, audioResourceId=${recording.id}, ` +
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
