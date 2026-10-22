import type { ChapterAssignmentStatus } from '../chapter-assignments.types';

export interface ChapterAssignmentsProgressFilters {
  projectId?: number;
  orgId?: number;
  assignedUserId?: number;
  peerCheckerId?: number;
  status?: ChapterAssignmentStatus;
}
