/**
 * Shared constants for the workflow-stages domain.
 * Imported by the service, repositories, and types — keeping them out of
 * the service module avoids a repository → service dependency inversion.
 */

export const MAX_WORKFLOW_STAGES = 10;

export const DEFAULT_WORKFLOW = [
  { defaultName: 'not_started', displayName: 'Not Started', position: 0, isFixed: true },
  { defaultName: 'draft', displayName: 'Drafting', position: 1, isFixed: true },
  { defaultName: 'peer_check', displayName: 'Peer Check', position: 2, isFixed: true },
  { defaultName: 'community_review', displayName: 'Community Review', position: 3, isFixed: false },
  { defaultName: 'linguist_check', displayName: 'Linguist Check', position: 4, isFixed: false },
  {
    defaultName: 'theological_check',
    displayName: 'Theological Check',
    position: 5,
    isFixed: false,
  },
  { defaultName: 'consultant_check', displayName: 'Consultant Check', position: 6, isFixed: false },
  { defaultName: 'complete', displayName: 'Complete', position: 7, isFixed: true },
] as const;

export const START_STAGE = 'not_started' as const;
export const END_STAGE = 'complete' as const;
