import { eq } from 'drizzle-orm';

import { db } from '../index';
import { project_unit_bible_books, project_units, projects } from '../schema';

async function backfill() {
  console.log('Starting Phase 1 Backfill...');

  await db.transaction(async (tx) => {
    // 1. Backfill sourceBibleId and pericopeSetId on projects
    const allProjects = await tx.select().from(projects);
    let updatedProjects = 0;

    for (const proj of allProjects) {
      const updates: Partial<typeof projects.$inferInsert> = {};
      let needsUpdate = false;

      // Check sourceBibleId
      if (!proj.sourceBibleId) {
        const units = await tx
          .select()
          .from(project_units)
          .where(eq(project_units.projectId, proj.id));

        if (units.length > 0) {
          const books = await tx
            .select()
            .from(project_unit_bible_books)
            .where(eq(project_unit_bible_books.projectUnitId, units[0].id));

          if (books.length > 0) {
            updates.sourceBibleId = books[0].bibleId;
            needsUpdate = true;
          } else {
            throw new Error(
              `Project ${proj.id} has no project_unit_bible_books rows, violating rollout gate!`
            );
          }
        }
      }

      // Check pericopeSetId
      const metadata = proj.metadata as Record<string, any> | null;
      if (metadata && metadata.pericopeSetId && !proj.pericopeSetId) {
        updates.pericopeSetId = metadata.pericopeSetId;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await tx.update(projects).set(updates).where(eq(projects.id, proj.id));
        updatedProjects++;
      }
    }
    console.log(`Updated sourceBibleId and pericopeSetId on ${updatedProjects} projects.`);

    // 2. Backfill name, type, and connectivity_profile on project_units
    const allUnits = await tx
      .select({
        unitId: project_units.id,
        projectId: projects.id,
        projectName: projects.name,
        metadata: projects.metadata,
        unitName: project_units.name,
      })
      .from(project_units)
      .innerJoin(projects, eq(projects.id, project_units.projectId));

    let updatedUnits = 0;
    for (const unit of allUnits) {
      if (!unit.unitName || unit.unitName === '') {
        const metadata = unit.metadata as Record<string, any> | null;
        const profile = metadata?.connectivityProfile || null;

        await tx
          .update(project_units)
          .set({
            name: unit.projectName,
            type: 'text', // default to text
            connectivityProfile: profile,
          })
          .where(eq(project_units.id, unit.unitId));
        updatedUnits++;
      }
    }
    console.log(`Updated name, type, and connectivityProfile on ${updatedUnits} project units.`);
  });

  console.log('Phase 1 Backfill Complete!');
  process.exit(0);
}

backfill().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
