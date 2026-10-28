import type { DemoSpec } from './types';

import { seedSpecChapterAssignments } from './assignments';
import { seedSpecBibles } from './bibles';
import { buildDemoCtx } from './context';
import { seedIngestJobs } from './ingest';
import { seedSpecBookLinks, seedSpecMilestones } from './milestones';
import { seedSpecLanguages, seedSpecOrganizations } from './orgs';
import { seedSpecProjects } from './projects';
import { cleanupStaleGrants, seedProjectGrants, seedSpecUsers } from './users';

/**
 * `seedDemoSpec` — interprets a declarative DemoSpec into seeded rows.
 *
 * Every stage reconciles rather than assumes a blank DB: create-if-missing,
 * update drifted fields, never duplicate. Ordering matters — later stages
 * resolve keys registered by earlier ones:
 *
 *   languages → orgs → bibles → users (+org-scoped & global grants)
 *   → projects → milestones → book links → chapter assignments
 *   → project-scoped grants → stale-grant cleanup → DBL ingest jobs
 *
 * Each stage lives in the module named for its resource (bibles.ts,
 * projects.ts, …); the shared key→id resolution state is `DemoCtx`.
 */
export async function seedDemoSpec(spec: DemoSpec): Promise<void> {
  const ctx = await buildDemoCtx(spec);

  console.log('  languages & orgs...');
  await seedSpecLanguages(ctx);
  await seedSpecOrganizations(ctx);
  console.log('  bibles & book links...');
  await seedSpecBibles(ctx);
  console.log('  users & org/global grants...');
  await seedSpecUsers(ctx);
  console.log('  projects...');
  await seedSpecProjects(ctx);
  console.log('  milestones...');
  await seedSpecMilestones(ctx);
  console.log('  project book links...');
  await seedSpecBookLinks(ctx);
  console.log('  chapter assignments...');
  await seedSpecChapterAssignments(ctx);
  console.log('  project-scoped grants...');
  await seedProjectGrants(ctx);
  await cleanupStaleGrants(ctx);
  console.log('  DBL text-ingest jobs...');
  await seedIngestJobs(ctx);
  console.log('Demo spec seeded.');
}
