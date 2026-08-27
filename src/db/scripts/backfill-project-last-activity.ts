import { sql } from 'drizzle-orm';

import { db } from '../index';

// One-time backfill of projects.last_activity_at from existing chapter/verse history. Safe to re-run. Run: npm run db:backfill-project-last-activity
async function backfillProjectLastActivity() {
  try {
    console.log('Starting projects.last_activity_at backfill...');

    const result = await db.execute(sql`
      UPDATE projects p
      SET last_activity_at = CASE
        WHEN p.last_activity_at IS NULL OR activity.max_ts > p.last_activity_at THEN activity.max_ts
        ELSE p.last_activity_at
      END
      FROM (
        SELECT
          pu.project_id AS project_id,
          MAX(
            GREATEST(
              COALESCE(ca_agg.max_updated_at, 'epoch'::timestamp),
              COALESCE(tv_agg.max_updated_at, 'epoch'::timestamp)
            )
          ) AS max_ts
        FROM project_units pu
        LEFT JOIN (
          SELECT project_unit_id, MAX(updated_at) AS max_updated_at
          FROM chapter_assignments
          GROUP BY project_unit_id
        ) ca_agg ON ca_agg.project_unit_id = pu.id
        LEFT JOIN (
          SELECT project_unit_id, MAX(updated_at) AS max_updated_at
          FROM translated_verses
          GROUP BY project_unit_id
        ) tv_agg ON tv_agg.project_unit_id = pu.id
        GROUP BY pu.project_id
      ) AS activity
      WHERE p.id = activity.project_id
        AND activity.max_ts > 'epoch'::timestamp
        AND (p.last_activity_at IS NULL OR activity.max_ts > p.last_activity_at);
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
