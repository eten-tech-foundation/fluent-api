import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { db } from '@/db';
import { bibles, chapter_assignments, languages, project_units, projects } from '@/db/schema';

// Aliases
export const sourceLanguages = alias(languages, 'sourceLanguages');
export const targetLanguages = alias(languages, 'targetLanguages');
export const sourceBibles = alias(bibles, 'sourceBibles');

// Subqueries
export const lastActivitySubquery = db
  .select({
    projectId: project_units.projectId,
    lastChapterActivity: sql<Date>`MAX(${chapter_assignments.updatedAt})`.as(
      'last_chapter_activity'
    ),
  })
  .from(chapter_assignments)
  .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
  .groupBy(project_units.projectId)
  .as('last_activity');

export const rawCountsSubquery = db
  .select({
    projectId: project_units.projectId,
    status: chapter_assignments.status,
    count: sql<number>`count(*)::int`.as('count'),
  })
  .from(chapter_assignments)
  .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
  .groupBy(project_units.projectId, chapter_assignments.status)
  .as('raw_counts');

export const chapterStatusCountsSubquery = db
  .select({
    projectId: rawCountsSubquery.projectId,
    counts: sql<Record<string, number>>`
      jsonb_object_agg(
        ${rawCountsSubquery.status}, 
        ${rawCountsSubquery.count}
      )
    `.as('counts'),
  })
  .from(rawCountsSubquery)
  .groupBy(rawCountsSubquery.projectId)
  .as('chapter_status_counts');

export const milestoneCountSubquery = db
  .select({
    projectId: project_units.projectId,
    milestoneCount: sql<number>`count(*)::int`.as('milestone_count'),
  })
  .from(project_units)
  .groupBy(project_units.projectId)
  .as('milestone_counts');

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
  lastChapterActivity: lastActivitySubquery.lastChapterActivity,
  lastActivityAt: projects.lastActivityAt,
  counts: chapterStatusCountsSubquery.counts,
  milestoneCount: sql<number>`coalesce(${milestoneCountSubquery.milestoneCount}, 0)`.as(
    'milestone_count'
  ),
} as const;

// Base join query — source bible comes from projects.source_bible_id so
// 0-unit and M-unit projects both load (review §1.3).
export const baseJoinQuery = () =>
  db
    .select(projectWithLangNames)
    .from(projects)
    .innerJoin(sourceLanguages, eq(projects.sourceLanguage, sourceLanguages.id))
    .innerJoin(targetLanguages, eq(projects.targetLanguage, targetLanguages.id))
    .innerJoin(sourceBibles, eq(sourceBibles.id, projects.sourceBibleId))
    .leftJoin(milestoneCountSubquery, eq(projects.id, milestoneCountSubquery.projectId))
    .leftJoin(lastActivitySubquery, eq(projects.id, lastActivitySubquery.projectId))
    .leftJoin(chapterStatusCountsSubquery, eq(projects.id, chapterStatusCountsSubquery.projectId));

// Derived types
export type BaseJoinQueryResult = Awaited<ReturnType<typeof baseJoinQuery>>;
export type RawProjectRow = BaseJoinQueryResult[number];
