import type { AppPolicyUser, Result } from '@/lib/types';

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
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getAllUsers(): Promise<Result<UserResponse[]>> {
  const result = await repo.findAll();
  if (!result.ok) return result;
  return ok(result.data.map(toUserResponse));
}

export async function getUsersByOrganization(
  organization: number
): Promise<Result<UserResponse[]>> {
  const result = await repo.findByOrganization(organization);
  if (!result.ok) return result;
  return ok(result.data.map(toUserResponse));
}

export async function getUsersForUser(user: AppPolicyUser): Promise<Result<UserResponse[]>> {
  // Global view grant (SuperAdmin) fetches all users
  const hasGlobalView = user.grants.some(
    (g) => g.orgId === null && g.projectId === null && g.permissions.has(PERMISSIONS.USER_VIEW)
  );
  if (hasGlobalView) {
    return getAllUsers();
  }

  const orgIds = new Set<number>();
  for (const g of user.grants) {
    if (g.permissions.has(PERMISSIONS.USER_VIEW) && g.orgId !== null) {
      orgIds.add(g.orgId);
    }
  }
  const result = await repo.findByOrganizations([...orgIds]);
  if (!result.ok) return result;
  return ok(result.data.map(toUserResponse));
}

export async function getUserById(id: number): Promise<Result<UserResponse>> {
  const result = await repo.findById(id);
  if (!result.ok) return result;
  return ok(toUserResponse(result.data));
}

export async function getUsersByIds(ids: number[]): Promise<Result<UserResponse[]>> {
  const result = await repo.findByIds(ids);
  if (!result.ok) return result;
  return ok(result.data.map(toUserResponse));
}

export async function getUserByEmail(email: string): Promise<Result<UserResponse>> {
  const result = await repo.findByEmail(email);
  if (!result.ok) return result;
  return ok(toUserResponse(result.data));
}

export async function getUserByUsername(username: string): Promise<Result<UserResponse>> {
  const result = await repo.findByUsername(username);
  if (!result.ok) return result;
  return ok(toUserResponse(result.data));
}

export async function getUserByEmailOrUsername(identifier: string): Promise<Result<UserResponse>> {
  const result = await repo.findByEmailOrUsername(identifier);
  if (!result.ok) return result;
  return ok(toUserResponse(result.data));
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
