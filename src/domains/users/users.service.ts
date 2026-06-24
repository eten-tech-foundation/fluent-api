import type { AppPolicyUser, Result } from '@/lib/types';

import { findRoleGrantsByUserIds } from '@/domains/user-roles/user-roles.repository';
import { logger } from '@/lib/logger';
import { PERMISSIONS } from '@/lib/permissions';
import { ok } from '@/lib/types';

import type {
  CreateUserInput,
  CreateUserWithAuthInput,
  UpdateUserInput,
  User,
  UserResponse,
} from './users.types';

import * as repo from './users.repository';

// ─── Response mapper ──────────────────────────────────────────────────────────

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    createdBy: user.createdBy,
    status: user.status,
    lastActiveOrgId: user.lastActiveOrgId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

async function attachGrants(user: User): Promise<UserResponse> {
  const response = toUserResponse(user);
  const grantsMap = await findRoleGrantsByUserIds([user.id], 'ALL');
  response.orgGrants = grantsMap.get(user.id) ?? [];

  logger.info(
    { userId: user.id, orgGrants: response.orgGrants },
    'Attached grants for user in attachGrants'
  );

  return response;
}

export async function getAllUsers(): Promise<Result<UserResponse[]>> {
  const result = await repo.findAll();
  if (!result.ok) return result;
  return ok(result.data.map(toUserResponse));
}

export async function getUsersForUser(user: AppPolicyUser): Promise<Result<UserResponse[]>> {
  // Global view grant (SuperAdmin) fetches all users
  const hasGlobalView = user.grants.some(
    (g) => g.orgId === null && g.projectId === null && g.permissions.has(PERMISSIONS.USER_VIEW)
  );

  let orgIdsArray: number[] = [];
  let userRows: User[] = [];

  if (hasGlobalView) {
    const result = await repo.findAll();
    if (!result.ok) return result;
    userRows = result.data;
  } else {
    const orgIds = new Set<number>();
    for (const g of user.grants) {
      if (g.permissions.has(PERMISSIONS.USER_VIEW) && g.orgId !== null) {
        orgIds.add(g.orgId);
      }
    }
    orgIdsArray = [...orgIds];
    const result = await repo.findByOrganizations(orgIdsArray);
    if (!result.ok) return result;
    userRows = result.data;
  }

  const userIds = userRows.map((u) => u.id);
  const filter = hasGlobalView ? 'ALL' : orgIdsArray;
  const grantsMap = await findRoleGrantsByUserIds(userIds, filter);

  logger.info(
    { callerId: user.id, count: userRows.length },
    'Returning users with grants in getUsersForUser'
  );

  return ok(
    userRows.map((u) => {
      const response = toUserResponse(u);
      response.orgGrants = grantsMap.get(u.id) ?? [];
      return response;
    })
  );
}

export async function getUserById(id: number): Promise<Result<UserResponse>> {
  const result = await repo.findById(id);
  if (!result.ok) return result;
  return ok(await attachGrants(result.data));
}

export async function getUsersByIds(ids: number[]): Promise<Result<UserResponse[]>> {
  const result = await repo.findByIds(ids);
  if (!result.ok) return result;

  const grantsMap = await findRoleGrantsByUserIds(ids, 'ALL');
  return ok(
    result.data.map((u) => {
      const response = toUserResponse(u);
      response.orgGrants = grantsMap.get(u.id) ?? [];
      return response;
    })
  );
}

export async function getUserByEmail(email: string): Promise<Result<UserResponse>> {
  const result = await repo.findByEmail(email);
  if (!result.ok) return result;
  return ok(await attachGrants(result.data));
}

export async function getUserByUsername(username: string): Promise<Result<UserResponse>> {
  const result = await repo.findByUsername(username);
  if (!result.ok) return result;
  return ok(await attachGrants(result.data));
}

export async function getUserByEmailOrUsername(identifier: string): Promise<Result<UserResponse>> {
  const result = await repo.findByEmailOrUsername(identifier);
  if (!result.ok) return result;
  return ok(await attachGrants(result.data));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export async function createUser(input: CreateUserInput): Promise<Result<UserResponse>> {
  const result = await repo.insert(input);
  if (!result.ok) return result;
  return ok(toUserResponse(result.data));
}

export async function createUserWithAuth(
  input: CreateUserWithAuthInput
): Promise<Result<UserResponse>> {
  const result = await repo.insert(input);
  if (!result.ok) return result;
  return ok(toUserResponse(result.data));
}

export async function updateUser(
  id: number,
  input: UpdateUserInput
): Promise<Result<UserResponse>> {
  const result = await repo.update(id, input);
  if (!result.ok) return result;
  return ok(toUserResponse(result.data));
}

export async function deleteUser(id: number): Promise<Result<void>> {
  return repo.remove(id);
}
