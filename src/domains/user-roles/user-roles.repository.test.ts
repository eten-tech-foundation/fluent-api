import { describe, expect, it } from 'vitest';

import { groupGrantRows } from './user-roles.repository';

describe('groupGrantRows', () => {
  it('groups permission rows by (orgId, projectId)', () => {
    const rows = [
      { orgId: 1, projectId: null, permission: 'project:view' },
      { orgId: 1, projectId: null, permission: 'project:create' },
      { orgId: 1, projectId: 10, permission: 'content:update' },
      { orgId: null, projectId: null, permission: 'project:delete' },
    ];
    const grants = groupGrantRows(rows);
    expect(grants).toHaveLength(3);
    const orgWide = grants.find((g) => g.orgId === 1 && g.projectId === null)!;
    expect([...orgWide.permissions].sort()).toEqual(['project:create', 'project:view']);
    const pinned = grants.find((g) => g.projectId === 10)!;
    expect([...pinned.permissions]).toEqual(['content:update']);
    const global = grants.find((g) => g.orgId === null && g.projectId === null)!;
    expect([...global.permissions]).toEqual(['project:delete']);
  });
});
