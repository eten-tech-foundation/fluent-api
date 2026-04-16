import type { Result } from '@/lib/types';

import { ok } from '@/lib/types';

import type { CreateUserInput, UpdateUserInput, User, UserResponse } from './users.types';

import * as repo from './users.repository';

// ─── Response mapper ──────────────────────────────────────────────────────────

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    createdBy: user.createdBy,
    organization: user.organization,
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

export async function getUserByEmail(
  email: string
): Promise<Result<UserResponse & { roleName: string }>> {
  const result = await repo.findByEmail(email);
  if (!result.ok) return result;
  return ok({ ...toUserResponse(result.data), roleName: result.data.roleName });
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
