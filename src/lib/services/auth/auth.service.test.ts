import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as userRolesService from '@/domains/user-roles/user-roles.service';
import * as mailgunService from '@/lib/services/notifications/mailgun.service';
import { err, ErrorCode, ok } from '@/lib/types';

import { inviteExistingUserToOrg } from './auth.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/domains/user-roles/user-roles.service', () => ({
  getRoleId: vi.fn(),
  grantRole: vi.fn(),
  inviteUserToOrg: vi.fn(),
}));

vi.mock('@/lib/services/notifications/mailgun.service', () => ({
  sendExistingUserOrgInviteEmail: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/env', () => ({
  default: { FRONTEND_URL: 'https://app.fluent.test' },
}));

// ─── Sample data ──────────────────────────────────────────────────────────────

const existingUser = {
  id: 42,
  username: 'joel',
  email: 'joel@example.com',
  firstName: 'Joel',
  lastName: 'George',
  status: 'verified' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 59,
  lastActiveOrgId: null,
  grants: [],
  orgGrants: [],
};

const baseInput = {
  existingUser,
  orgId: 2,
  projectId: 83,
  roleName: 'Project Translator',
  createdBy: 59,
  orgName: 'orgb',
  inviterName: 'Patricia PM',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('inviteExistingUserToOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userRolesService.getRoleId).mockResolvedValue(3);
    vi.mocked(userRolesService.inviteUserToOrg).mockResolvedValue(ok(undefined));
    vi.mocked(userRolesService.grantRole).mockResolvedValue(ok(undefined));
    vi.mocked(mailgunService.sendExistingUserOrgInviteEmail).mockResolvedValue(undefined);
  });

  it('creates anchor row before project grant', async () => {
    await inviteExistingUserToOrg(baseInput);

    expect(userRolesService.inviteUserToOrg).toHaveBeenCalledWith(
      existingUser.id,
      baseInput.orgId,
      baseInput.createdBy
    );
    // inviteUserToOrg must be called before grantRole
    const anchorOrder = vi
      .mocked(userRolesService.inviteUserToOrg)
      .mock.invocationCallOrder[0]!;
    const grantOrder = vi
      .mocked(userRolesService.grantRole)
      .mock.invocationCallOrder[0]!;
    expect(anchorOrder).toBeLessThan(grantOrder);
  });

  it('grants the project-scoped role with correct params', async () => {
    await inviteExistingUserToOrg(baseInput);

    expect(userRolesService.grantRole).toHaveBeenCalledWith({
      userId: existingUser.id,
      orgId: baseInput.orgId,
      projectId: baseInput.projectId,
      roleId: 3,
      createdBy: baseInput.createdBy,
    });
  });

  it('defaults to Project Translator when no roleName provided', async () => {
    const { roleName: _omit, ...inputWithoutRole } = baseInput;
    await inviteExistingUserToOrg(inputWithoutRole);

    // getRoleId should be called with the default role name
    expect(userRolesService.getRoleId).toHaveBeenCalledWith('Project Translator');
  });

  it('returns ok with user data on success', async () => {
    const result = await inviteExistingUserToOrg(baseInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.user.id).toBe(existingUser.id);
      expect(result.data.user.email).toBe(existingUser.email);
    }
  });

  it('sends login-link email with correct data', async () => {
    await inviteExistingUserToOrg(baseInput);

    expect(mailgunService.sendExistingUserOrgInviteEmail).toHaveBeenCalledWith({
      email: existingUser.email,
      firstName: existingUser.username,
      inviterName: baseInput.inviterName,
      orgName: baseInput.orgName,
      loginUrl: 'https://app.fluent.test/login',
    });
  });

  it('returns error when grantRole fails', async () => {
    vi.mocked(userRolesService.grantRole).mockResolvedValue(
      err(ErrorCode.INTERNAL_ERROR)
    );

    const result = await inviteExistingUserToOrg(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    }
    // Email should NOT be sent if the grant failed
    expect(mailgunService.sendExistingUserOrgInviteEmail).not.toHaveBeenCalled();
  });

  it('handles missing orgName and inviterName gracefully', async () => {
    const minimalInput = {
      existingUser,
      orgId: 2,
      projectId: 83,
      createdBy: 59,
    };

    const result = await inviteExistingUserToOrg(minimalInput);

    expect(result.ok).toBe(true);
    expect(mailgunService.sendExistingUserOrgInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ inviterName: null, orgName: null })
    );
  });
});
