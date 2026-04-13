import { z } from '@hono/zod-openapi';

import {
  chapterStatusEnum,
  insertProjectsSchema,
  patchProjectsClientSchema,
  selectProjectsSchema,
} from '@/db/schema';

export const chapterStatusCountsSchema = z.object(
  chapterStatusEnum.enumValues.reduce(
    (acc, status) => {
      acc[status] = z.number().int().min(0);
      return acc;
    },
    {} as Record<string, z.ZodNumber>
  )
);

export const workflowStepSchema = z.object({
  id: z.string(),
  label: z.string(),
});

export const projectResponseSchema = selectProjectsSchema.openapi('Project');

export const projectWithLanguageNamesSchema = selectProjectsSchema
  .omit({ sourceLanguage: true, targetLanguage: true })
  .extend({
    sourceLanguageName: z.string(),
    targetLanguageName: z.string(),
    sourceName: z.string(),
    lastChapterActivity: z.union([z.date(), z.string()]).nullable(),
    createdAt: z.union([z.date(), z.string()]).nullable(),
    updatedAt: z.union([z.date(), z.string()]).nullable(),
    chapterStatusCounts: chapterStatusCountsSchema,
    workflowConfig: z.array(workflowStepSchema),
  });

export const createProjectWithUnitsSchema = insertProjectsSchema
  .omit({ status: true, organization: true, createdBy: true })
  .extend({
    bibleId: z.number().int(),
    bookId: z.array(z.number().int()),
    projectUnitStatus: z.enum(['not_started', 'in_progress', 'completed']).default('not_started'),
    // Made optional for frontend backwards compatibility.
    // The route will overwrite these with secure auth context anyway.
    organization: z.number().int().optional(),
    createdBy: z.number().int().optional(),
  });

export const updateProjectWithUnitsSchema = patchProjectsClientSchema
  .omit({ status: true })
  .extend({
    bibleId: z.number().int().optional(),
    bookId: z.array(z.number().int()).optional(),
    projectUnitStatus: z.enum(['not_started', 'in_progress', 'completed']).optional(),
  });

// Domain types inferred from Zod

export type Project = z.infer<typeof selectProjectsSchema>;
export type CreateProjectData = z.infer<typeof insertProjectsSchema>;
export type UpdateProjectData = z.infer<typeof patchProjectsClientSchema>;
export type ChapterStatusCounts = z.infer<typeof chapterStatusCountsSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type ProjectWithLanguageNames = z.infer<typeof projectWithLanguageNamesSchema>;
export type CreateProjectInput = z.infer<typeof createProjectWithUnitsSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectWithUnitsSchema>;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export interface ProjectUnitRef {
  projectId: number;
}

// Service layer input that guarantees auth context is strictly provided by the route
export interface CreateProjectServiceInput extends CreateProjectInput {
  organization: number;
  createdBy: number;
}

// Const enumerations

export const PROJECT_ACTIONS = {
  LIST: 'list',
  READ: 'read',
  UPDATE: 'update',
  DELETE: 'delete',
} as const;

export type ProjectAction = (typeof PROJECT_ACTIONS)[keyof typeof PROJECT_ACTIONS];
