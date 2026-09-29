import { eq, sql } from 'drizzle-orm';
import { stdin as input, stdout as output } from 'node:process';
/**
 * Auto-consolidation.
 *
 * Grouping key is strictly organization + language pair + sourceBibleId +
 * pericopeSetId + createdBy — name is deliberately NOT part of the key. Within a matched
 * group:
 *   - same name as the master  -> merged automatically, no prompt.
 *   - different name           -> you're asked interactively whether to merge it in.
 *
 * Flags:
 *   --dry-run   Log what would happen without writing anything.
 *   --yes       Skip prompts entirely; merge every match including differently-named ones.
 */
import { createInterface } from 'node:readline/promises';

import type { ProjectRow } from './merge-project-group';

import { db } from '../index';
import { project_units, projects, user_roles } from '../schema';
import { mergeProjectGroup } from './merge-project-group';

const isDryRun = process.argv.includes('--dry-run');
const autoYes = process.argv.includes('--yes');

const rl = createInterface({ input, output });

async function confirm(question: string): Promise<boolean> {
  if (autoYes) return true;
  const answer = (await rl.question(`${question} (y/n) `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

async function runConsolidation() {
  console.log(`Starting Project Consolidation Script...${isDryRun ? ' [DRY RUN]' : ''}`);

  const allProjects = (await db.select().from(projects)) as ProjectRow[];
  const groups = new Map<string, ProjectRow[]>();

  for (const proj of allProjects) {
    if (!proj.sourceBibleId) {
      console.warn(`Project ${proj.id} has no sourceBibleId, skipping...`);
      continue;
    }

    const key = [
      proj.organization,
      proj.targetLanguage,
      proj.sourceLanguage,
      proj.sourceBibleId,
      proj.pericopeSetId ?? 'null',
      proj.createdBy,
    ].join('-');

    const group = groups.get(key) || [];
    group.push(proj);
    groups.set(key, group);
  }

  let mergedProjectsCount = 0;
  let masterProjectsCount = 0;
  let skippedCount = 0;

  for (const [key, group] of groups.entries()) {
    if (group.length <= 1) continue; // No consolidation needed

    // Sort by createdAt ascending, so the oldest becomes the master.
    // If createdAt is missing, fallback to id ascending.
    group.sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        const timeDiff =
          new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime();
        if (timeDiff !== 0) return timeDiff;
      } else if (a.createdAt && !b.createdAt) {
        return -1;
      } else if (!a.createdAt && b.createdAt) {
        return 1;
      }
      return a.id - b.id;
    });
    const master = group[0];
    const candidateDuplicates = group.slice(1);

    console.log(`\nGroup: ${key} -> Master: Project ID ${master.id} ("${master.name}")`);

    const duplicatesToMerge: ProjectRow[] = [];
    for (const dup of candidateDuplicates) {
      if (dup.name === master.name) {
        duplicatesToMerge.push(dup);
        continue;
      }

      // Same language pair + source Bible, but a different name — confirm before merging.
      const shouldMerge = await confirm(
        `  Project ${dup.id} ("${dup.name}") matches master ${master.id} ("${master.name}") ` +
          `on language pair + source Bible, but has a different name. Merge it in?`
      );

      if (shouldMerge) {
        duplicatesToMerge.push(dup);
      } else {
        console.log(`  Skipping Project ${dup.id} — left as its own project.`);
        skippedCount++;
      }
    }

    if (duplicatesToMerge.length === 0) continue;

    const initialCounts = new Map<number, { unitCount: number; roleCount: number }>();
    for (const proj of [master, ...duplicatesToMerge]) {
      const [unitCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(project_units)
        .where(eq(project_units.projectId, proj.id));
      const [roleCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(user_roles)
        .where(eq(user_roles.projectId, proj.id));
      initialCounts.set(proj.id, {
        unitCount: Number(unitCount.count),
        roleCount: Number(roleCount.count),
      });
    }

    await db.transaction(async (tx) => {
      // Lock all projects involved in the merge
      const allProjectIds = [master.id, ...duplicatesToMerge.map((d) => d.id)];
      const projectIdsSql = allProjectIds.map((id) => sql`${id}`);
      await tx.execute(
        sql`SELECT id FROM ${projects} WHERE id IN (${sql.join(projectIdsSql, sql`, `)}) ORDER BY id FOR UPDATE`
      );

      // Recompute counts and abort if they differ
      for (const proj of [master, ...duplicatesToMerge]) {
        const [unitCount] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(project_units)
          .where(eq(project_units.projectId, proj.id));
        const [roleCount] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(user_roles)
          .where(eq(user_roles.projectId, proj.id));

        const initial = initialCounts.get(proj.id)!;
        if (
          Number(unitCount.count) !== initial.unitCount ||
          Number(roleCount.count) !== initial.roleCount
        ) {
          throw new Error(
            `Concurrency error: Project ${proj.id} has had units or roles added since the preview. Aborting.`
          );
        }
      }

      // Check master explicitly as before to satisfy the type cast, though it's already locked
      const [lockedMaster] = await tx.select().from(projects).where(eq(projects.id, master.id));
      if (!lockedMaster) throw new Error(`Master project ${master.id} no longer exists.`);

      const success = await mergeProjectGroup(tx, lockedMaster as ProjectRow, duplicatesToMerge, {
        isDryRun,
      });
      if (success) {
        masterProjectsCount++;
        mergedProjectsCount += duplicatesToMerge.length;
      }
    });
  }

  rl.close();

  console.log(`\nConsolidation complete!`);
  console.log(`Master Projects retained: ${masterProjectsCount}`);
  console.log(`Duplicate Projects merged & deleted: ${mergedProjectsCount}`);
  console.log(`Differently-named projects left unmerged: ${skippedCount}`);
  process.exit(0);
}

runConsolidation().catch((e) => {
  console.error('Consolidation failed:', e);
  rl.close();
  process.exit(1);
});
