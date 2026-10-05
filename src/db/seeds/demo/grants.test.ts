import { describe, expect, it } from 'vitest';

import type { DemoSpec } from './types';

import { buildGrantPlan, isStaleProjectRoleGrant } from './grants';

const spec: DemoSpec = {
  organizations: [
    { key: 'org-a', name: 'Org A' },
    { key: 'org-b', name: 'Org B' },
  ],
  users: [
    {
      key: 'om',
      email: 'om@x.test',
      username: 'om',
      orgs: [{ org: 'org-a', roles: ['Org Manager'] }],
    },
    {
      key: 'pm',
      email: 'pm@x.test',
      username: 'pm',
      orgs: [{ org: 'org-a', roles: ['Org Member'] }],
      projectRoles: [
        { project: 'p1', role: 'Project Manager' },
        { project: 'p2', role: 'Project Manager' },
      ],
    },
    {
      key: 'admin',
      email: 'admin@x.test',
      username: 'admin',
      globalRoles: ['SuperAdmin'],
    },
  ],
  projects: [
    {
      key: 'p1',
      org: 'org-a',
      name: 'P1',
      sourceLanguage: 'eng',
      targetLanguage: 'spa',
      sourceBible: 'IRV',
      milestones: [],
    },
    {
      key: 'p2',
      org: 'org-b',
      name: 'P2',
      sourceLanguage: 'eng',
      targetLanguage: 'spa',
      sourceBible: 'IRV',
      milestones: [],
    },
  ],
};

describe('buildGrantPlan', () => {
  const plan = buildGrantPlan(spec);
  const grantsFor = (key: string) => plan.filter((g) => g.userKey === key);

  it('gives every org member the Org Member anchor automatically', () => {
    const pm = grantsFor('pm');
    expect(pm).toContainEqual({ userKey: 'pm', roleName: 'Org Member', orgKey: 'org-a', projectKey: null });
    const om = grantsFor('om');
    expect(om).toContainEqual({ userKey: 'om', roleName: 'Org Member', orgKey: 'org-a', projectKey: null });
    // anchor is not duplicated when declared explicitly
    expect(om.filter((g) => g.roleName === 'Org Member')).toHaveLength(1);
  });

  it('scopes Org Manager to the org (projectId null)', () => {
    expect(grantsFor('om')).toContainEqual({
      userKey: 'om',
      roleName: 'Org Manager',
      orgKey: 'org-a',
      projectKey: null,
    });
  });

  it('scopes project roles to the project AND the project\'s org — never the user\'s membership org', () => {
    const pm = grantsFor('pm');
    expect(pm).toContainEqual({
      userKey: 'pm',
      roleName: 'Project Manager',
      orgKey: 'org-a',
      projectKey: 'p1',
    });
    // cross-org: p2 lives in org-b, so the grant carries org-b even though
    // the user is not an org-b member
    expect(pm).toContainEqual({
      userKey: 'pm',
      roleName: 'Project Manager',
      orgKey: 'org-b',
      projectKey: 'p2',
    });
    // project roles are never org-scoped
    expect(
      pm.filter((g) => g.roleName === 'Project Manager' && g.projectKey === null)
    ).toHaveLength(0);
  });

  it('gives a SuperAdmin exactly one global grant and nothing else', () => {
    expect(grantsFor('admin')).toEqual([
      { userKey: 'admin', roleName: 'SuperAdmin', orgKey: null, projectKey: null },
    ]);
  });
});

describe('isStaleProjectRoleGrant', () => {
  it('flags project-level roles sitting at org scope (projectId null)', () => {
    expect(isStaleProjectRoleGrant({ roleName: 'Project Manager', projectKey: null })).toBe(true);
    expect(isStaleProjectRoleGrant({ roleName: 'Project Translator', projectKey: null })).toBe(true);
    expect(isStaleProjectRoleGrant({ roleName: 'Project Observer', projectKey: null })).toBe(true);
  });

  it('keeps correctly-scoped grants', () => {
    expect(isStaleProjectRoleGrant({ roleName: 'Project Manager', projectKey: 'p1' })).toBe(false);
    expect(isStaleProjectRoleGrant({ roleName: 'Org Member', projectKey: null })).toBe(false);
    expect(isStaleProjectRoleGrant({ roleName: 'Org Manager', projectKey: null })).toBe(false);
    expect(isStaleProjectRoleGrant({ roleName: 'SuperAdmin', projectKey: null })).toBe(false);
  });
});
