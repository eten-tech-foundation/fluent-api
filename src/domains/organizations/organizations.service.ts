import type { Result } from '@/lib/types';

import { err, ErrorCode, ok } from '@/lib/types';

import type {
  CreateOrganizationInput,
  OrganizationRecord,
  OrganizationResponse,
  OrganizationSummary,
  OrganizationSummaryRecord,
} from './organizations.types';

import * as repo from './organizations.repository';

// ─── Response mappers ─────────────────────────────────────────────────────────

function toOrganizationResponse(row: OrganizationRecord): OrganizationResponse {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

function toOrganizationSummary(row: OrganizationSummaryRecord): OrganizationSummary {
  return {
    ...toOrganizationResponse(row),
    orgManagerCount: row.orgManagerCount,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function listOrganizations(): Promise<Result<OrganizationSummary[]>> {
  const result = await repo.findAllWithCounts();
  if (!result.ok) return result;
  return ok(result.data.map(toOrganizationSummary));
}

export async function getOrganization(id: number): Promise<Result<OrganizationSummary>> {
  const result = await repo.findByIdWithCounts(id);
  if (!result.ok) return result;
  if (!result.data) return err(ErrorCode.NOT_FOUND);
  return ok(toOrganizationSummary(result.data));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export async function createOrganization(
  input: CreateOrganizationInput
): Promise<Result<OrganizationResponse>> {
  const result = await repo.insert(input);
  if (!result.ok) {
    // Unique violation on organizations.name → 409 Conflict
    return result.error.code === ErrorCode.DUPLICATE ? err(ErrorCode.CONFLICT) : result;
  }
  return ok(toOrganizationResponse(result.data));
}
