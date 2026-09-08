import { eq, sql } from 'drizzle-orm';

import { db } from '../index';
import { project_units, projects, user_roles } from '../schema';

const isDryRun = process.argv.includes('--dry-run');

async function runConsolidation() {
  console.log(`Starting Project Consolidation Script...${isDryRun ? ' [DRY RUN]' : ''}`);

  // 1. Group projects by (organization, targetLanguage, sourceLanguage, sourceBibleId, pericopeSetId)
  const allProjects = await db.select().from(projects);

  const groups = new Map<string, typeof allProjects>();

  for (const proj of allProjects) {
    if (!proj.sourceBibleId) {
      console.warn(`Project ${proj.id} has no sourceBibleId, skipping...`);
      continue;
    }
    // Include pericopeSetId in the grouping key to prevent merging incompatible scopes
    const key = `${proj.organization}-${proj.targetLanguage}-${proj.sourceLanguage}-${proj.sourceBibleId}-${proj.pericopeSetId || 'null'}`;
    const group = groups.get(key) || [];
    group.push(proj);
    groups.set(key, group);
  }

  let mergedProjectsCount = 0;
  let masterProjectsCount = 0;

  for (const [key, group] of groups.entries()) {
    if (group.length <= 1) {
      continue; // No consolidation needed
    }

    // Sort by id descending, so the newest/highest ID becomes the master.
    group.sort((a, b) => b.id - a.id);
    const master = group[0];
    const duplicates = group.slice(1);

    console.log(`\nGroup: ${key} -> Master: Project ID ${master.id}`);

    await db.transaction(async (tx) => {
      masterProjectsCount++;

      for (const dup of duplicates) {
        console.log(`  Merging Project ID ${dup.id} into Master ID ${master.id}`);

        // Move project_units to master
        if (!isDryRun) {
          await tx
            .update(project_units)
            .set({ projectId: master.id })
            .where(eq(project_units.projectId, dup.id));
        }

        // Move user_roles to master, avoiding duplicates
        const existingMasterRoles = await tx
          .select()
          .from(user_roles)
          .where(eq(user_roles.projectId, master.id));
        const existingSet = new Set(
          existingMasterRoles.map((r) => `${r.userId}-${r.orgId}-${r.roleId}`)
        );

        const rolesToMove = await tx
          .select()
          .from(user_roles)
          .where(eq(user_roles.projectId, dup.id));

        for (const role of rolesToMove) {
          const roleKey = `${role.userId}-${role.orgId}-${role.roleId}`;
          if (!existingSet.has(roleKey)) {
            if (!isDryRun) {
              await tx.insert(user_roles).values({
                userId: role.userId,
                orgId: role.orgId,
                projectId: master.id,
                roleId: role.roleId,
                createdBy: role.createdBy,
              });
            } else {
              console.log(
                `    [DRY RUN] Would insert user_role: User ${role.userId}, Role ${role.roleId}`
              );
            }
            existingSet.add(roleKey); // Track newly added to prevent duplicates from within the merge group
          }
        }

        // Delete the duplicate user_roles on the duplicate project
        if (!isDryRun) {
          await tx.delete(user_roles).where(eq(user_roles.projectId, dup.id));
        }

        // Finally, check that no units or roles are left before deleting the old project
        const remainingUnits = await tx
          .select({ count: sql<number>`count(*)` })
          .from(project_units)
          .where(eq(project_units.projectId, dup.id));
        const remainingRoles = await tx
          .select({ count: sql<number>`count(*)` })
          .from(user_roles)
          .where(eq(user_roles.projectId, dup.id));

        if (Number(remainingUnits[0].count) > 0 || Number(remainingRoles[0].count) > 0) {
          throw new Error(`Orphaned records detected for Project ${dup.id}! Aborting merge.`);
        }

        if (!isDryRun) {
          await tx.delete(projects).where(eq(projects.id, dup.id));
        }

        mergedProjectsCount++;
      }
    });
  }

  console.log(`\nConsolidation complete!`);
  console.log(`Master Projects retained: ${masterProjectsCount}`);
  console.log(`Duplicate Projects merged & deleted: ${mergedProjectsCount}`);

  process.exit(0);
}

runConsolidation().catch((e) => {
  console.error('Consolidation failed:', e);
  process.exit(1);
});
