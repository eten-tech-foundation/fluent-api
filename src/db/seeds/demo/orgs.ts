import { eq, inArray } from 'drizzle-orm';

import { db } from '@/db';
import { languages, organizations } from '@/db/schema';

import type { DemoCtx } from './context';

// ─── Stage 1: languages ─────────────────────────────────────────────────────

export async function seedSpecLanguages(ctx: DemoCtx) {
  for (const lang of ctx.spec.languages ?? []) {
    const [existing] = await db
      .select({ id: languages.id })
      .from(languages)
      .where(eq(languages.langCodeIso6393, lang.code))
      .limit(1);
    if (!existing) {
      await db.insert(languages).values({
        langName: lang.name,
        langNameLocalized: lang.localizedName ?? null,
        langCodeIso6393: lang.code,
      });
      console.log(`  language ${lang.code} (${lang.name})`);
    }
  }

  // Resolve every language code the spec references (spec rows + reference data).
  const codes = new Set<string>();
  for (const p of ctx.spec.projects) {
    codes.add(p.sourceLanguage);
    codes.add(p.targetLanguage);
  }
  for (const b of ctx.spec.bibles ?? []) codes.add(b.language);
  for (const l of ctx.spec.languages ?? []) codes.add(l.code);

  const rows = await db
    .select({ id: languages.id, code: languages.langCodeIso6393 })
    .from(languages)
    .where(inArray(languages.langCodeIso6393, [...codes]));
  for (const r of rows) {
    if (r.code) ctx.languages.set(r.code, r.id);
  }
  const missing = [...codes].filter((c) => !ctx.languages.has(c));
  if (missing.length) {
    throw new Error(
      `Unknown language codes: ${missing.join(', ')} — not in spec or reference data`
    );
  }
}

// ─── Stage 2: organizations ─────────────────────────────────────────────────

export async function seedSpecOrganizations(ctx: DemoCtx) {
  for (const org of ctx.spec.organizations) {
    const [existing] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, org.name))
      .limit(1);
    if (existing) {
      ctx.orgs.set(org.key, existing.id);
    } else {
      const [row] = await db
        .insert(organizations)
        .values({ name: org.name })
        .returning({ id: organizations.id });
      ctx.orgs.set(org.key, row.id);
      console.log(`  org ${org.name}`);
    }
  }
}
