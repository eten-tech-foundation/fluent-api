import { and, eq, inArray } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { bible_books, bible_provider_resources, bibles, books, languages } from '@/db/schema';

const IRV_BIBLE = {
  name: 'IRV Gujarati',
  abbreviation: 'IRV',
  languageCode: 'guj',
  // API.Bible catalogue ids (public identifiers, not credentials): the text
  // bible and its selected audio recording — real Gujarati IRV audio.
  externalId: 'a3644a98420c2703-01',
  audioExternalId: '2abea5341ec34814-01',
  licenseNotice:
    'Indian Revised Version (IRV) © 2019 Bridge Connectivity Solutions. CC BY-SA 4.0.',
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

  // 3. Resolve the bible row by upstream identity first: (provider,
  // externalId) is canonical — a catalogue sync may already own it under a
  // different abbreviation (e.g. QA's IRVGuj). Adopt the holder rather than
  // stamp the same external_id on a second row, which would violate
  // idx_bibles_provider_external_id. When unowned, claim it on the 'IRV'
  // abbreviation row (or create that row fresh).
  const [holder] = await db
    .select({
      id: bibles.id,
      hasAudio: bibles.hasAudio,
      audioResourceId: bibles.audioResourceId,
    })
    .from(bibles)
    .where(and(eq(bibles.provider, 'dbl'), eq(bibles.externalId, IRV_BIBLE.externalId)))
    .limit(1);

  let bibleId: number;
  if (holder) {
    bibleId = holder.id;
    if (!holder.hasAudio || holder.audioResourceId !== recording.id) {
      await db
        .update(bibles)
        .set({ hasAudio: true, audioResourceId: recording.id })
        .where(eq(bibles.id, holder.id));
    }
  } else {
    await db
      .insert(bibles)
      .values({
        name: IRV_BIBLE.name,
        abbreviation: IRV_BIBLE.abbreviation,
        languageId: language.id,
        externalId: IRV_BIBLE.externalId,
        hasAudio: true,
        audioResourceId: recording.id,
      })
      .onConflictDoNothing({ target: bibles.abbreviation });

    const [bible] = await db
      .select({
        id: bibles.id,
        externalId: bibles.externalId,
        hasAudio: bibles.hasAudio,
        audioResourceId: bibles.audioResourceId,
      })
      .from(bibles)
      .where(eq(bibles.abbreviation, IRV_BIBLE.abbreviation))
      .limit(1);

    if (!bible) {
      throw new Error('IRV bible not found after insert.');
    }
    if (bible.externalId && bible.externalId !== IRV_BIBLE.externalId) {
      throw new Error(
        `Bible "${IRV_BIBLE.abbreviation}" holds a different upstream identity ` +
          `(${bible.externalId}) — reconcile it manually before seeding.`
      );
    }
    bibleId = bible.id;

    if (
      bible.externalId !== IRV_BIBLE.externalId ||
      !bible.hasAudio ||
      bible.audioResourceId !== recording.id
    ) {
      await db
        .update(bibles)
        .set({
          externalId: IRV_BIBLE.externalId,
          hasAudio: true,
          audioResourceId: recording.id,
        })
        .where(eq(bibles.id, bible.id));
    }
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

  // Resolve by upstream identity first (same adopt/claim split as the IRV
  // seed above): a catalogue sync may own bba9f… under a suffixed
  // abbreviation while the bare 'BSB' row points at a different upstream id.
  const [holder] = await db
    .select({ id: bibles.id, audioResourceId: bibles.audioResourceId })
    .from(bibles)
    .where(and(eq(bibles.provider, 'dbl'), eq(bibles.externalId, BSB_BIBLE.externalId)))
    .limit(1);

  let bibleId: number;
  if (holder) {
    bibleId = holder.id;
    if (holder.audioResourceId !== recording.id) {
      await db
        .update(bibles)
        .set({ audioResourceId: recording.id })
        .where(eq(bibles.id, holder.id));
    }
  } else {
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
      .select({
        id: bibles.id,
        externalId: bibles.externalId,
        audioResourceId: bibles.audioResourceId,
      })
      .from(bibles)
      .where(eq(bibles.abbreviation, BSB_BIBLE.abbreviation))
      .limit(1);

    if (!bible) {
      throw new Error('BSB bible not found after insert.');
    }
    if (bible.externalId && bible.externalId !== BSB_BIBLE.externalId) {
      throw new Error(
        `Bible "${BSB_BIBLE.abbreviation}" holds a different upstream identity ` +
          `(${bible.externalId}) — reconcile it manually before seeding.`
      );
    }
    bibleId = bible.id;

    if (bible.externalId !== BSB_BIBLE.externalId || bible.audioResourceId !== recording.id) {
      await db
        .update(bibles)
        .set({ externalId: BSB_BIBLE.externalId, audioResourceId: recording.id })
        .where(eq(bibles.id, bible.id));
    }
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
