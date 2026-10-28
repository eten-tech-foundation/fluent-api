import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { project_unit_bible_books, project_units } from '@/db/schema';

import type { DemoCtx } from './context';

// ─── Stage 6: milestones ────────────────────────────────────────────────────

export async function seedSpecMilestones(ctx: DemoCtx) {
  for (const project of ctx.spec.projects) {
    const projectId = ctx.projects.get(project.key)!;
    for (const milestone of project.milestones) {
      // Same seed-marker convention as projects above: key reconciles on the
      // spec identity; a (projectId, name) match is adopted only when unmarked
      // so a spec rename never duplicates a milestone with all its links.
      const seedTag = `demo:${project.key}/${milestone.key}`;
      let [existing] = await db
        .select()
        .from(project_units)
        .where(
          and(
            eq(project_units.projectId, projectId),
            sql`${project_units.metadata}->>'seed' = ${seedTag}`
          )
        )
        .limit(1);
      if (!existing) {
        const [candidate] = await db
          .select()
          .from(project_units)
          .where(
            and(eq(project_units.projectId, projectId), eq(project_units.name, milestone.name))
          )
          // (projectId, name) isn't unique — order so adoption picks the oldest match.
          .orderBy(project_units.id)
          .limit(1);
        if (candidate && (candidate.metadata as Record<string, unknown> | null)?.seed == null) {
          existing = candidate;
          await db
            .update(project_units)
            .set({
              metadata: {
                ...((candidate.metadata as Record<string, unknown>) ?? {}),
                seed: seedTag,
              },
            })
            .where(eq(project_units.id, candidate.id));
        }
      }

      const want = {
        type: milestone.type ?? 'text',
        status: milestone.status ?? 'in_progress',
        connectivityProfile: milestone.connectivityProfile ?? null,
      };

      if (!existing) {
        const [row] = await db
          .insert(project_units)
          .values({ projectId, name: milestone.name, metadata: { seed: seedTag }, ...want })
          .returning({ id: project_units.id });
        ctx.milestones.set(`${project.key}/${milestone.key}`, row.id);
        console.log(`  milestone ${milestone.name} (${project.name})`);
        continue;
      }

      ctx.milestones.set(`${project.key}/${milestone.key}`, existing.id);
      const drifted: Partial<typeof project_units.$inferInsert> = {};
      if (existing.name !== milestone.name) drifted.name = milestone.name;
      if (existing.type !== want.type) drifted.type = want.type;
      if (existing.status !== want.status) drifted.status = want.status;
      if (existing.connectivityProfile !== want.connectivityProfile) {
        drifted.connectivityProfile = want.connectivityProfile;
      }
      if (Object.keys(drifted).length) {
        await db.update(project_units).set(drifted).where(eq(project_units.id, existing.id));
      }
    }
  }
}

// ─── Stage 7: book links (deletedAt-aware) ──────────────────────────────────

export async function seedSpecBookLinks(ctx: DemoCtx) {
  for (const project of ctx.spec.projects) {
    const bibleId = ctx.bibles.get(project.sourceBible)!;
    for (const milestone of project.milestones) {
      const unitId = ctx.milestones.get(`${project.key}/${milestone.key}`)!;
      for (const book of milestone.books) {
        const bookId = ctx.books.get(book.code)!;
        const [link] = await db
          .select()
          .from(project_unit_bible_books)
          .where(
            and(
              eq(project_unit_bible_books.projectUnitId, unitId),
              eq(project_unit_bible_books.bookId, bookId)
            )
          )
          .limit(1);

        if (!link) {
          await db
            .insert(project_unit_bible_books)
            .values({ projectUnitId: unitId, bibleId, bookId });
        } else if (link.deletedAt || link.bibleId !== bibleId) {
          // Restore soft-deleted links rather than inserting a duplicate —
          // mirrors createMilestone's move-back semantics — and reconcile a
          // drifted bibleId on live rows too.
          await db
            .update(project_unit_bible_books)
            .set({ deletedAt: null, bibleId })
            .where(
              and(
                eq(project_unit_bible_books.projectUnitId, unitId),
                eq(project_unit_bible_books.bookId, bookId)
              )
            );
          console.log(`  reconciled book link ${book.code} → ${milestone.name}`);
        }
      }
    }
  }
}
