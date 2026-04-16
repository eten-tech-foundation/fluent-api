import * as projectsService from '@/domains/projects/projects.service';
import { ok } from '@/lib/types';

import type { ProjectWithLanguageNames, UserProjectResponse } from './user-projects.types';

// ─── Response mapper ──────────────────────────────────────────────────────────
export function toUserProjectResponse(project: ProjectWithLanguageNames): UserProjectResponse {
  return project;
}

// ─── Service functions ────────────────────────────────────────────────────────
export async function getProjectsByUserId(userId: number) {
  const result = await projectsService.getProjectsByUserId(userId);
  if (!result.ok) return result;
  return ok(result.data.map(toUserProjectResponse));
}
