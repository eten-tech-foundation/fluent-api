import { z } from '@hono/zod-openapi';

import type { UsjVerseText } from '@/lib/usfm-converter';

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
    sourceLanguageId: z.number().int(),
    targetLanguageId: z.number().int(),
    sourceLanguageName: z.string(),
    targetLanguageName: z.string(),
    sourceName: z.string().nullable(),
    lastChapterActivity: z.union([z.date(), z.string()]).nullable(),
    createdAt: z.union([z.date(), z.string()]).nullable(),
    updatedAt: z.union([z.date(), z.string()]).nullable(),
    chapterStatusCounts: chapterStatusCountsSchema,
    milestoneCount: z.number().int().min(0),
    workflowConfig: z.array(workflowStepSchema),
  });

export const usfmFileSchema = z.object({
  fileName: z.string().min(1).max(255),
  bookCode: z.string().min(3).max(4),
  usfm: z.string().min(1),
});

export type UsfmFileInput = z.infer<typeof usfmFileSchema>;

export interface ParsedUsfmFile extends UsfmFileInput {
  bookId: number;
  verses: UsjVerseText[];
}

export const createProjectSchema = insertProjectsSchema
  .omit({ status: true, organization: true, createdBy: true })
  .extend({
    sourceBibleId: z.number().int().optional(),
    // Compatibility for clients that still create the initial unit with the project.
    bibleId: z.number().int().optional(),
    bookId: z.array(z.number().int()).optional(),
    projectUnitStatus: z.enum(['not_started', 'in_progress', 'completed']).optional(),
    usfmFiles: z.array(usfmFileSchema).min(1).optional(),
    // organization is optional — omitting it triggers solo-workflow auto-provisioning:
    // the route will create a personal org for users with zero existing orgs.
    organization: z.number().int().optional(),
    createdBy: z.number().int().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.sourceBibleId == null && input.bibleId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceBibleId'],
        message: 'A source Bible is required',
      });
    }
    if (
      input.sourceBibleId != null &&
      input.bibleId != null &&
      input.sourceBibleId !== input.bibleId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bibleId'],
        message: 'Source Bible IDs must match',
      });
    }
  });

export const updateProjectSchema = patchProjectsClientSchema.omit({ status: true }).extend({
  sourceBibleId: z.number().int().optional(),
});

// Domain types inferred from Zod

export type Project = z.infer<typeof selectProjectsSchema>;
export type CreateProjectData = z.infer<typeof insertProjectsSchema>;
export type UpdateProjectData = z.infer<typeof patchProjectsClientSchema>;
export type ChapterStatusCounts = z.infer<typeof chapterStatusCountsSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type ProjectWithLanguageNames = z.infer<typeof projectWithLanguageNamesSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
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
