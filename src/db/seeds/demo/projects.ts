import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { pericope_sets, project_workflow_stages, projects } from '@/db/schema';
import { DEFAULT_WORKFLOW } from '@/domains/projects/workflow-stages/workflow-stages.constants';

import type { DemoCtx } from './context';
import type { DemoProject } from './types';

import { globalActorKey, orgManagerKey } from './actors';

// ─── Stage 5: projects ──────────────────────────────────────────────────────

export async function seedSpecProjects(ctx: DemoCtx) {
  const pmKeyFor = (project: DemoProject) =>
    ctx.spec.users.find((u) =>
      u.projectRoles?.some((r) => r.project === project.key && r.role === 'Project Manager')
    )?.key;

  for (const project of ctx.spec.projects) {
    const orgId = ctx.orgs.get(project.org);
    if (!orgId) throw new Error(`Project "${project.key}" references unknown org "${project.org}"`);
    const sourceLanguage = ctx.languages.get(project.sourceLanguage)!;
    const targetLanguage = ctx.languages.get(project.targetLanguage)!;
    const sourceBibleId = ctx.bibles.get(project.sourceBible);
    if (!sourceBibleId) {
      throw new Error(`Project "${project.key}" references unknown bible "${project.sourceBible}"`);
    }

    let pericopeSetId: number | null = null;
    if (project.pericopeSet) {
      if (!ctx.pericopeSets.size) {
        const rows = await db
          .select({ id: pericope_sets.id, name: pericope_sets.name })
          .from(pericope_sets);
        for (const r of rows) ctx.pericopeSets.set(r.name, r.id);
      }
      pericopeSetId = ctx.pericopeSets.get(project.pericopeSet) ?? null;
      if (!pericopeSetId) {
        throw new Error(
          `Project "${project.key}" references unknown pericope set "${project.pericopeSet}" — run db:seed:pericope-sets first`
        );
      }
    }

    const creatorKey =
      pmKeyFor(project) ?? orgManagerKey(ctx.spec, project.org) ?? globalActorKey(ctx.spec);
    const createdBy = creatorKey ? (ctx.users.get(creatorKey) ?? null) : null;

    // Reconcile by seed marker, not display name: projects are user-renamable,
    // and a spec `name` edit must neither spawn a duplicate nor claim a
    // user-created project that shares the name (same convention as the
    // audio-demo seed's `metadata.seed` marker).
    const seedTag = `demo:${project.key}`;
    let [existing] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.organization, orgId), sql`${projects.metadata}->>'seed' = ${seedTag}`))
      .orderBy(projects.id)
      .limit(1);
    if (!existing) {
      // Rows seeded before the marker existed carry it nowhere — adopt an
      // unmarked (name, org) match once and stamp the marker so future
      // reconciles key on it. A row marked for a *different* spec key is a
      // name collision, not ours to adopt.
      const [candidate] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.name, project.name), eq(projects.organization, orgId)))
        // (name, org) isn't unique — order so adoption picks the oldest match.
        .orderBy(projects.id)
        .limit(1);
      if (candidate) {
        const marked = (candidate.metadata as Record<string, unknown> | null)?.seed;
        if (marked == null) {
          existing = candidate;
          await db
            .update(projects)
            .set({
              metadata: {
                ...((candidate.metadata as Record<string, unknown>) ?? {}),
                seed: seedTag,
              },
            })
            .where(eq(projects.id, candidate.id));
        }
      }
    }

    if (!existing) {
      const [row] = await db
        .insert(projects)
        .values({
          name: project.name,
          sourceLanguage,
          targetLanguage,
          organization: orgId,
          status: 'active',
          sourceBibleId,
          pericopeSetId,
          createdBy,
          metadata: { seed: seedTag },
        })
        .returning({ id: projects.id });
      ctx.projects.set(project.key, row.id);
      await ensureWorkflowStages(row.id);
      console.log(`  project ${project.name}`);
      continue;
    }

    ctx.projects.set(project.key, existing.id);
    await ensureWorkflowStages(existing.id);
    const drifted: Partial<typeof projects.$inferInsert> = {};
    // Seed-owned row (marker matched): the spec name is a reconcilable
    // attribute like any other — a spec rename updates the row in place.
    if (existing.name !== project.name) drifted.name = project.name;
    if (existing.sourceBibleId !== sourceBibleId) drifted.sourceBibleId = sourceBibleId;
    if (existing.pericopeSetId !== pericopeSetId) drifted.pericopeSetId = pericopeSetId;
    if (existing.status !== 'active') drifted.status = 'active';
    if (existing.sourceLanguage !== sourceLanguage) drifted.sourceLanguage = sourceLanguage;
    if (existing.targetLanguage !== targetLanguage) drifted.targetLanguage = targetLanguage;
    if (Object.keys(drifted).length) {
      await db.update(projects).set(drifted).where(eq(projects.id, existing.id));
      console.log(`  project ${project.name} reconciled`);
    }
  }
}

/**
 * Converges a project's workflow stages to the default set. Chapter statuses
 * are validated against `project_workflow_stages` rows — the engine inserts
 * `projects` directly (bypassing the repository path that creates them), so
 * demo projects need the stages written here. `onConflictDoNothing` fills gaps
 * without clobbering a stage the project has since customized.
 */
async function ensureWorkflowStages(projectId: number) {
  await db
    .insert(project_workflow_stages)
    .values(
      DEFAULT_WORKFLOW.map((s) => ({
        projectId,
        defaultName: s.defaultName,
        displayName: s.displayName,
        position: s.position,
        isFixed: s.isFixed,
      }))
    )
    .onConflictDoNothing();
}
