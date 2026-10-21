import type { MilestoneSummaryRow } from '@/domains/milestones/milestones.types';
import type { Result } from '@/lib/types';

import * as milestonesService from '@/domains/milestones/milestones.service';
import * as userProjectsService from '@/domains/users/projects/user-projects.service';
import { ok } from '@/lib/types';

import type { UserMilestone } from './user-milestones.types';

export function toUserMilestoneResponse(row: MilestoneSummaryRow): UserMilestone {
  return {
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    projectName: row.projectName,
  };
}

export async function getMilestonesByUserId(
  userId: number,
  orgId?: number
): Promise<Result<UserMilestone[]>> {
  const projectsResult = await userProjectsService.getProjectsByUserId(userId, orgId);
  if (!projectsResult.ok) return projectsResult;

  const projectIds = projectsResult.data.map((project) => project.id);
  if (projectIds.length === 0) return ok([]);

  const milestonesResult = await milestonesService.listMilestonesForProjects(projectIds);
  if (!milestonesResult.ok) return milestonesResult;

  return ok(milestonesResult.data.map(toUserMilestoneResponse));
}
