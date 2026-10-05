import { z } from '@hono/zod-openapi';

export const createOrganizationRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const organizationResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  createdAt: z.string().datetime().nullable(),
});

export const organizationSummarySchema = organizationResponseSchema.extend({
  // Distinct users holding an Org Manager grant with projectId IS NULL.
  orgManagerCount: z.number().int(),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationRequestSchema>;
export type OrganizationResponse = z.infer<typeof organizationResponseSchema>;
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;

// Repository row shape — createdAt stays a Date; the service serializes it.
export interface OrganizationRecord {
  id: number;
  name: string;
  createdAt: Date | null;
}

export interface OrganizationSummaryRecord extends OrganizationRecord {
  orgManagerCount: number;
}
