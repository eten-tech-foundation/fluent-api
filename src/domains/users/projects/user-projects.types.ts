import type { z } from '@hono/zod-openapi';

import { projectWithLanguageNamesSchema } from '@/domains/projects/projects.types';

export type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';

// ─── API response schema ──────────────────────────────────────────────────────

export const userProjectResponseSchema = projectWithLanguageNamesSchema;

export type UserProjectResponse = z.infer<typeof userProjectResponseSchema>;
