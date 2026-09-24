import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { db } from '@/db';
import { bibles, languages, projects } from '@/db/schema';

// Aliases
export const sourceLanguages = alias(languages, 'sourceLanguages');
export const targetLanguages = alias(languages, 'targetLanguages');
export const sourceBibles = alias(bibles, 'sourceBibles');

// Projection
export const projectWithLangNames = {
  id: projects.id,
  name: projects.name,
  organization: projects.organization,
  isActive: projects.isActive,
  status: projects.status,
  createdBy: projects.createdBy,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  metadata: projects.metadata,
  pericopeSetId: projects.pericopeSetId,
  sourceBibleId: projects.sourceBibleId,
  sourceLanguageId: projects.sourceLanguage,
  targetLanguageId: projects.targetLanguage,
  sourceLanguageName: sourceLanguages.langName,
  targetLanguageName: targetLanguages.langName,
  sourceName: sourceBibles.name,
  lastChapterActivity: sql<Date>`(
    SELECT MAX(chapter_assignments.updated_at) FROM chapter_assignments
    INNER JOIN project_units ON chapter_assignments.project_unit_id = project_units.id
    WHERE project_units.project_id = ${projects.id}
  )`.as('last_chapter_activity'),
  lastActivityAt: projects.lastActivityAt,
  counts: sql<Record<string, number>>`(
    SELECT jsonb_object_agg(t.chapter_status, t.count) FROM (
      SELECT chapter_assignments.chapter_status, count(*) as count FROM chapter_assignments
      INNER JOIN project_units ON chapter_assignments.project_unit_id = project_units.id
      WHERE project_units.project_id = ${projects.id}
      GROUP BY chapter_assignments.chapter_status
    ) t
  )`.as('counts'),
  milestoneCount: sql<number>`(
    SELECT count(*)::int FROM project_units
    WHERE project_id = ${projects.id}
  )`.as('milestone_count'),
} as const;

// Base join query
export const baseJoinQuery = () =>
  db
    .selectDistinct(projectWithLangNames)
    .from(projects)
    .innerJoin(sourceLanguages, eq(projects.sourceLanguage, sourceLanguages.id))
    .innerJoin(targetLanguages, eq(projects.targetLanguage, targetLanguages.id))
    .leftJoin(sourceBibles, eq(sourceBibles.id, projects.sourceBibleId))
    .groupBy(projects.id, sourceLanguages.id, targetLanguages.id, sourceBibles.id);

// Derived types
export type BaseJoinQueryResult = Awaited<ReturnType<typeof baseJoinQuery>>;
export type RawProjectRow = BaseJoinQueryResult[number];
