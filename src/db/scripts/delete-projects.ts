/**
 * Hard-delete one or more projects by id.
 *
 * Because project_units.projectId and user_roles.projectId (and everything
 * cascading further from project_units — translated_verses, chapter_assignments,
 * ai_suggestions, etc.) are FK'd with onDelete: 'cascade', deleting the project
 * row is enough; Postgres cascades the rest. There is NO milestone trace left
 * behind for a delete — this is permanent. Always run --dry-run first.
 *
 * Usage:
 *   npx tsx delete-projects.ts --ids="4,5,9" --dry-run
 *   npx tsx delete-projects.ts --ids="4,5,9"            # prompts for confirmation
 *   npx tsx delete-projects.ts --ids="4,5,9" --yes       # skips the prompt
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { db } from '../index';
import { project_units, projects, user_roles } from '../schema';

const isDryRun = process.argv.includes('--dry-run');
const autoYes = process.argv.includes('--yes');

function getArg(flag: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split('=').slice(1).join('=') : undefined;
}

async function deleteProjects() {
  const idsArg = getArg('ids');
  if (!idsArg) {
    console.error('Usage: npx tsx delete-projects.ts --ids="4,5,9" [--dry-run] [--yes]');
    process.exit(1);
  }

  const ids = idsArg
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number);

  if (ids.some((id) => Number.isNaN(id))) {
    console.error(`Invalid id in --ids="${idsArg}" — all values must be numbers.`);
    process.exit(1);
  }

  console.log(`Starting Project Deletion...${isDryRun ? ' [DRY RUN]' : ''}`);

  const rows = await db.select().from(projects).where(inArray(projects.id, ids));

  const missing = ids.filter((id) => !rows.find((r) => r.id === id));
  if (missing.length > 0) {
    console.warn(`Project id(s) not found (already deleted?): ${missing.join(', ')}`);
  }

  if (rows.length === 0) {
    console.log('Nothing to delete.');
    process.exit(0);
  }

  console.log(`\nAbout to permanently delete ${rows.length} project(s):\n`);

  for (const proj of rows) {
    const [unitCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(project_units)
      .where(eq(project_units.projectId, proj.id));
    const [roleCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(user_roles)
      .where(eq(user_roles.projectId, proj.id));

    console.log(
      `  Project ${proj.id} ("${proj.name}") — will cascade-delete ${unitCount.count} unit(s) ` +
        `and ${roleCount.count} user role grant(s), plus everything under those units ` +
        `(verses, assignments, AI suggestions, audio recordings, etc.).`
    );
  }

  if (isDryRun) {
    console.log('\n[DRY RUN] No changes made.');
    process.exit(0);
  }

  if (!autoYes) {
    const rl = createInterface({ input, output });
    const answer = (
      await rl.question(
        `\nType DELETE to permanently remove ${rows.length} project(s) and everything under them: `
      )
    ).trim();
    rl.close();

    if (answer !== 'DELETE') {
      console.log('Aborted — no changes made.');
      process.exit(0);
    }
  }

  await db.delete(projects).where(
    inArray(
      projects.id,
      rows.map((r) => r.id)
    )
  );

  console.log(`\nDeleted ${rows.length} project(s) and all cascaded data.`);
  process.exit(0);
}

deleteProjects().catch((e) => {
  console.error('Deletion failed:', e);
  process.exit(1);
});
