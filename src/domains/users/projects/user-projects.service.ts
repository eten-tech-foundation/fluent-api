import * as projectsService from '@/domains/projects/projects.service';
import { ok } from '@/lib/types';

import type { ProjectWithLanguageNames, UserProjectResponse } from './user-projects.types';

// ─── Response mapper ──────────────────────────────────────────────────────────
export function toUserProjectResponse(project: ProjectWithLanguageNames): UserProjectResponse {
  return project;
}

// ─── Service functions ────────────────────────────────────────────────────────
export async function getProjectsByUserId(userId: number, orgId?: number, roleName?: string) {
  const result = await projectsService.getProjectsByUserId(userId, orgId, undefined, roleName);
  if (!result.ok) return result;
  return ok(result.data.map(toUserProjectResponse));
}
