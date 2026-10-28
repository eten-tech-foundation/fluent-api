import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/db';
import { bible_books, bible_provider_resources, bibles, books } from '@/db/schema';
import { suffixedAbbreviation } from '@/db/seeds/reference-bibles';

import type { DemoCtx } from './context';

// ─── Stage 3: bibles + book links ───────────────────────────────────────────

export async function seedSpecBibles(ctx: DemoCtx) {
  // Books used anywhere in the spec — resolve codes once.
  const codes = new Set<string>();
  for (const b of ctx.spec.bibles ?? []) for (const c of b.books ?? []) codes.add(c);
  for (const p of ctx.spec.projects)
    for (const m of p.milestones) for (const bk of m.books) codes.add(bk.code);

  if (codes.size) {
    const rows = await db
      .select({ id: books.id, code: books.code })
      .from(books)
      .where(inArray(books.code, [...codes]));
    for (const r of rows) ctx.books.set(r.code, r.id);
    const missing = [...codes].filter((c) => !ctx.books.has(c));
    if (missing.length) {
      throw new Error(`Unknown book codes: ${missing.join(', ')} — run db:seed:books first`);
    }
  }

  for (const spec of ctx.spec.bibles ?? []) {
    const languageId = ctx.languages.get(spec.language)!;

    // Provider-resource identities — the text row backs the TTS license
    // gate (`bibleKey` lookups), the audio row is the selectable recording.
    // Bare provider ids only; the `dbl-…` bibleKey form lives in responses.
    const upsertResource = async (externalId: string) => {
      const [row] = await db
        .insert(bible_provider_resources)
        .values({
          provider: 'dbl',
          externalId,
          ttsLicenseStatus: spec.ttsLicenseStatus ?? 'unknown',
          licenseNotice: spec.licenseNotice,
          displayName: spec.name,
        })
        .onConflictDoUpdate({
          target: [bible_provider_resources.provider, bible_provider_resources.externalId],
          set: {
            ttsLicenseStatus: spec.ttsLicenseStatus ?? 'unknown',
            licenseNotice: spec.licenseNotice,
            displayName: spec.name,
          },
        })
        .returning({ id: bible_provider_resources.id });
      return row.id;
    };
    if (spec.externalId) await upsertResource(spec.externalId);
    const audioResourceId = spec.audioExternalId
      ? await upsertResource(spec.audioExternalId)
      : undefined;

    // (provider, externalId) is the canonical upstream identity — resolve the
    // holder first. A catalogue sync may already own it under a different
    // abbreviation (e.g. QA's 'BSB-bba9f4' when 'BSB' itself is a different
    // upstream row); stamping the same external_id on a second row violates
    // idx_bibles_provider_external_id.
    let bible:
      | {
          id: number;
          hasAudio: boolean;
          externalId: string | null;
          audioResourceId: number | null;
        }
      | undefined;
    if (spec.externalId) {
      [bible] = await db
        .select({
          id: bibles.id,
          hasAudio: bibles.hasAudio,
          externalId: bibles.externalId,
          audioResourceId: bibles.audioResourceId,
        })
        .from(bibles)
        .where(and(eq(bibles.provider, 'dbl'), eq(bibles.externalId, spec.externalId)))
        .limit(1);
    }
    if (!bible) {
      [bible] = await db
        .select({
          id: bibles.id,
          hasAudio: bibles.hasAudio,
          externalId: bibles.externalId,
          audioResourceId: bibles.audioResourceId,
        })
        .from(bibles)
        .where(eq(bibles.abbreviation, spec.abbreviation))
        .limit(1);
      // An abbreviation row claiming a *different* upstream identity is left
      // untouched — the spec bible gets its own row instead.
      if (bible?.externalId && spec.externalId && bible.externalId !== spec.externalId) {
        bible = undefined;
      }
    }
    if (!bible) {
      let abbreviation = spec.abbreviation;
      if (spec.externalId) {
        const [taken] = await db
          .select({ id: bibles.id })
          .from(bibles)
          .where(eq(bibles.abbreviation, spec.abbreviation))
          .limit(1);
        // Mirror the catalogue sync's collision-suffix convention so the new
        // row reads the same way as sync-generated ones (and next run's holder
        // lookup finds it by externalId).
        if (taken) abbreviation = suffixedAbbreviation(spec.abbreviation, spec.externalId);
      }
      [bible] = await db
        .insert(bibles)
        .values({
          abbreviation,
          name: spec.name,
          languageId,
          externalId: spec.externalId,
          hasAudio: spec.hasAudio ?? false,
          audioResourceId,
        })
        .returning({
          id: bibles.id,
          hasAudio: bibles.hasAudio,
          externalId: bibles.externalId,
          audioResourceId: bibles.audioResourceId,
        });
      console.log(`  bible ${abbreviation}`);
    } else {
      // Spec-provided values win on reconcile; omitted spec values leave
      // whatever the row already has. externalId is only ever claimed onto a
      // row whose identity is NULL — a differing non-null one exited above.
      const patch: { externalId?: string; hasAudio?: boolean; audioResourceId?: number } = {};
      if (spec.externalId !== undefined && bible.externalId !== spec.externalId)
        patch.externalId = spec.externalId;
      if (spec.hasAudio !== undefined && bible.hasAudio !== spec.hasAudio)
        patch.hasAudio = spec.hasAudio;
      if (audioResourceId !== undefined && bible.audioResourceId !== audioResourceId)
        patch.audioResourceId = audioResourceId;
      if (Object.keys(patch).length)
        await db.update(bibles).set(patch).where(eq(bibles.id, bible.id));
    }
    ctx.bibles.set(spec.abbreviation, bible.id);

    // Link books — dedupe existing links like seeds/bibles.ts does.
    const linked = await db
      .select({ bookId: bible_books.bookId })
      .from(bible_books)
      .where(eq(bible_books.bibleId, bible.id));
    const linkedIds = new Set(linked.map((l) => l.bookId));
    const toInsert = (spec.books ?? [])
      .map((code) => ctx.books.get(code)!)
      .filter((id) => !linkedIds.has(id))
      .map((bookId) => ({ bibleId: bible.id, bookId }));
    if (toInsert.length) await db.insert(bible_books).values(toInsert);
  }

  // Resolve bible abbreviations referenced by projects (may be reference
  // data). Spec bibles were already resolved by upstream identity above — a
  // by-abbreviation hit on those keys can be a *different* row (e.g. bare
  // 'BSB' vs the adopted 'BSB-bba9f4'), so only look up unresolved keys.
  const abbrevs = new Set<string>([
    ...(ctx.spec.bibles ?? []).map((b) => b.abbreviation),
    ...ctx.spec.projects.map((p) => p.sourceBible),
  ]);
  const unresolved = [...abbrevs].filter((a) => !ctx.bibles.has(a));
  if (unresolved.length) {
    const rows = await db
      .select({ id: bibles.id, abbreviation: bibles.abbreviation })
      .from(bibles)
      .where(inArray(bibles.abbreviation, unresolved));
    for (const r of rows) ctx.bibles.set(r.abbreviation, r.id);
  }
  const missing = [...abbrevs].filter((a) => !ctx.bibles.has(a));
  if (missing.length) {
    throw new Error(`Unknown bibles: ${missing.join(', ')} — not in spec or reference data`);
  }
}
