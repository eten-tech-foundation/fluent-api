import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { project_unit_bible_books, project_units } from '@/db/schema';

import type { DemoCtx } from './context';

// ─── Stage 6: milestones ────────────────────────────────────────────────────

export async function seedSpecMilestones(ctx: DemoCtx) {
  for (const project of ctx.spec.projects) {
    const projectId = ctx.projects.get(project.key)!;
    for (const milestone of project.milestones) {
      // Reconciled by (projectId, name). Not unique — order so a rerun keeps
      // picking the oldest match. Renaming a milestone in the spec or by hand
      // just seeds a fresh one; demo data is disposable (reset, don't repair).
      const [existing] = await db
        .select()
        .from(project_units)
        .where(and(eq(project_units.projectId, projectId), eq(project_units.name, milestone.name)))
        .orderBy(project_units.id)
        .limit(1);

      const want = {
        type: milestone.type ?? 'text',
        status: milestone.status ?? 'in_progress',
        connectivityProfile: milestone.connectivityProfile ?? null,
      };

      if (!existing) {
        const [row] = await db
          .insert(project_units)
          .values({ projectId, name: milestone.name, ...want })
          .returning({ id: project_units.id });
        ctx.milestones.set(`${project.key}/${milestone.key}`, row.id);
        console.log(`  milestone ${milestone.name} (${project.name})`);
        continue;
      }

      ctx.milestones.set(`${project.key}/${milestone.key}`, existing.id);
      const drifted: Partial<typeof project_units.$inferInsert> = {};
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
