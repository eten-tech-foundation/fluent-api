import { stdin as input, stdout as output } from 'node:process';
/**
 * Auto-consolidation.
 *
 * Grouping key is strictly organization + language pair + sourceBibleId +
 * pericopeSetId — name is deliberately NOT part of the key. Within a matched
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
import { projects } from '../schema';
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
        return (
          new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime()
        );
      }
      if (a.createdAt && !b.createdAt) return 1;
      if (!a.createdAt && b.createdAt) return -1;
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

    await db.transaction(async (tx) => {
      masterProjectsCount++;
      await mergeProjectGroup(tx, master, duplicatesToMerge, { isDryRun });
      mergedProjectsCount += duplicatesToMerge.length;
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
