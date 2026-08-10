import { sql } from 'drizzle-orm';

import { db } from '../index';

// One-time backfill of projects.last_activity_at from existing chapter/verse history. Safe to re-run. Run: npm run db:backfill-project-last-activity
async function backfillProjectLastActivity() {
  try {
    console.log('Starting projects.last_activity_at backfill...');

    const result = await db.execute(sql`
      UPDATE projects p
      SET last_activity_at = activity.max_ts
      FROM (
        SELECT
          pu.project_id AS project_id,
          GREATEST(
            COALESCE(MAX(ca.updated_at), 'epoch'::timestamp),
            COALESCE(MAX(tv.updated_at), 'epoch'::timestamp)
          ) AS max_ts
        FROM project_units pu
        LEFT JOIN chapter_assignments ca ON ca.project_unit_id = pu.id
        LEFT JOIN translated_verses tv ON tv.project_unit_id = pu.id
        GROUP BY pu.project_id
      ) AS activity
      WHERE p.id = activity.project_id
        AND activity.max_ts > 'epoch'::timestamp;
    `);

    // postgres-js exposes affected-row count via `.count` for non-RETURNING
    // statements (there's no RETURNING here, so `.length` would read as 0).
    const updatedCount = (result as unknown as { count?: number }).count ?? 'unknown number of';
    console.log(`Backfill complete. ${updatedCount} project(s) updated.`);
    process.exit(0);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
}

backfillProjectLastActivity();
