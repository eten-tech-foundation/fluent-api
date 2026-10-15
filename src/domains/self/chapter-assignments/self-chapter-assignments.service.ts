import type { UserChapterAssignmentsByUserResponse } from '@/domains/users/chapter-assignments/users-chapter-assignments.types';
import type { Result } from '@/lib/types';

import * as userChapterAssignmentsService from '@/domains/users/chapter-assignments/users-chapter-assignments.service';
import * as userProjectsService from '@/domains/users/projects/user-projects.service';
import { ok } from '@/lib/types';

// Removal keeps assignedUserId on chapters past draft, so current project
// membership — not the assignment row — decides whether this list includes them.
export async function getChapterAssignmentsForCurrentProjects(
  userId: number,
  orgId?: number
): Promise<Result<UserChapterAssignmentsByUserResponse>> {
  const [projectsResult, assignmentsResult] = await Promise.all([
    userProjectsService.getProjectsByUserId(userId, orgId),
    userChapterAssignmentsService.getAllChapterAssignmentsByUserId(userId, orgId),
  ]);
  if (!projectsResult.ok) return projectsResult;
  if (!assignmentsResult.ok) return assignmentsResult;

  const projectIds = new Set(projectsResult.data.map((project) => project.id));
  return ok({
    assignedChapters: assignmentsResult.data.assignedChapters.filter((chapter) =>
      projectIds.has(chapter.projectId)
    ),
    peerCheckChapters: assignmentsResult.data.peerCheckChapters.filter((chapter) =>
      projectIds.has(chapter.projectId)
    ),
  });
}
