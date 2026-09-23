import { eq, sql } from 'drizzle-orm';

import { project_units, projects, user_roles } from '../schema';

export interface ProjectRow {
  id: number;
  name: string;
  organization: number;
  targetLanguage: number;
  sourceLanguage: number;
  sourceBibleId: number | null;
  pericopeSetId: number | null;
  metadata: unknown;
  [key: string]: unknown;
}

interface MergeOptions {
  isDryRun: boolean;
}

interface MilestoneEntry {
  name: string;
  originalName: string;
  sourceProjectId: number;
  metadata: unknown;
  mergedAt: string;
}

/**
 * Merges `duplicates` into `master`:
 *  - Moves project_units to master.
 *  - Moves user_roles to master (de-duped).
 *  - Records each duplicate under master.metadata.milestones (audit trail).
 *    No dedicated milestones table — this reuses the existing `metadata`
 *    jsonb column on `projects`, so no migration is required.
 *  - Deletes the duplicate project row once verified empty.
 */
export async function mergeProjectGroup(
  tx: any, // replace `any` with your drizzle transaction type
  master: ProjectRow,
  duplicates: ProjectRow[],
  { isDryRun }: MergeOptions
) {
  const masterMetadata = (master.metadata as Record<string, any>) || {};
  const milestones: MilestoneEntry[] = Array.isArray(masterMetadata.milestones)
    ? [...masterMetadata.milestones]
    : [];

  // First time this master is used in a merge: its own existing unit(s)
  // become "Milestone 1" (etc.) too, so the master's original work is tracked
  // the same way as anything merged into it later. Guarded by milestones being
  // empty so re-running against an already-converted master is a no-op here.
  if (milestones.length === 0) {
    const mastersOwnUnits = await tx
      .select()
      .from(project_units)
      .where(eq(project_units.projectId, master.id));

    for (const unit of mastersOwnUnits) {
      const milestoneName = `Milestone ${milestones.length + 1}`;
      milestones.push({
        name: milestoneName,
        originalName: master.name,
        sourceProjectId: master.id,
        metadata: masterMetadata,
        mergedAt: new Date().toISOString(),
      });

      if (!isDryRun) {
        await tx
          .update(project_units)
          .set({ name: milestoneName })
          .where(eq(project_units.id, unit.id));
      } else {
        console.log(
          `    [DRY RUN] Would rename master ${master.id}'s own unit "${unit.name}" to "${milestoneName}"`
        );
      }
    }
  }

  for (const dup of duplicates) {
    console.log(
      `  Merging Project ID ${dup.id} ("${dup.name}") into Master ID ${master.id} ("${master.name}")`
    );

    // 1. Move project_units to master, giving each unit its own milestone
    // label and its own audit-trail entry in master.metadata.
    const dupUnits = await tx
      .select()
      .from(project_units)
      .where(eq(project_units.projectId, dup.id));

    for (const unit of dupUnits) {
      const milestoneName = `Milestone ${milestones.length + 1}`;
      milestones.push({
        name: milestoneName,
        originalName: dup.name,
        sourceProjectId: dup.id,
        metadata: dup.metadata ?? null,
        mergedAt: new Date().toISOString(),
      });

      if (!isDryRun) {
        await tx
          .update(project_units)
          .set({ projectId: master.id, name: milestoneName })
          .where(eq(project_units.id, unit.id));
      } else {
        console.log(
          `    [DRY RUN] Would move unit "${unit.name}" of Project ${dup.id} to master ${master.id}, renamed to "${milestoneName}"`
        );
      }
    }

    // 2. Move user_roles to master, avoiding duplicates
    const existingMasterRoles = await tx
      .select()
      .from(user_roles)
      .where(eq(user_roles.projectId, master.id));
    const existingSet = new Set(
      existingMasterRoles.map((r: any) => `${r.userId}-${r.orgId}-${r.roleId}`)
    );

    const rolesToMove = await tx.select().from(user_roles).where(eq(user_roles.projectId, dup.id));

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
        existingSet.add(roleKey);
      }
    }

    if (!isDryRun) {
      await tx.delete(user_roles).where(eq(user_roles.projectId, dup.id));
    }

    // 3. Safety check before deleting the duplicate project row.
    // Only meaningful on a real run — in dry-run mode nothing above was
    // actually moved, so this would always find data "left behind" and
    // false-positive on every group.
    if (!isDryRun) {
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

      await tx.delete(projects).where(eq(projects.id, dup.id));
    } else {
      console.log(
        `    [DRY RUN] Would verify no orphaned records remain, then delete Project ${dup.id}`
      );
    }
  }

  // Persist the accumulated milestone history onto the master's metadata in one write.
  if (!isDryRun) {
    await tx
      .update(projects)
      .set({ metadata: { ...masterMetadata, milestones } })
      .where(eq(projects.id, master.id));
  } else if (duplicates.length > 0) {
    console.log(
      `    [DRY RUN] Would record ${duplicates.length} milestone(s) on master ${master.id}'s metadata`
    );
  }
}
