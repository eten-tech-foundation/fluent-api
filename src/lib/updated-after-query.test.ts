import { describe, expect, it } from 'vitest';

import { updatedAfterQuerySchema } from './updated-after-query';

describe('updatedAfterQuerySchema', () => {
  it('allows an omitted value', () => {
    expect(updatedAfterQuerySchema.safeParse(undefined)).toEqual({
      success: true,
      data: undefined,
    });
  });

  it('parses a zoned ISO date-time into a Date', () => {
    const result = updatedAfterQuerySchema.safeParse('2025-01-01T00:00:00.000Z');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(new Date('2025-01-01T00:00:00.000Z'));
    }
  });

  it('accepts numeric offsets', () => {
    const result = updatedAfterQuerySchema.safeParse('2025-01-01T00:00:00+00:00');
    expect(result.success).toBe(true);
  });

  it('rejects an empty string instead of treating it as omitted', () => {
    expect(updatedAfterQuerySchema.safeParse('').success).toBe(false);
  });

  it('rejects date-times without an explicit time zone', () => {
    expect(updatedAfterQuerySchema.safeParse('2025-01-01T00:00:00').success).toBe(false);
  });

  it('rejects date-only values', () => {
    expect(updatedAfterQuerySchema.safeParse('2025-01-01').success).toBe(false);
  });

  it('rejects invalid calendar dates that Date would roll over', () => {
    expect(updatedAfterQuerySchema.safeParse('2025-02-30T00:00:00.000Z').success).toBe(false);
  });

  it('rejects non-ISO garbage', () => {
    expect(updatedAfterQuerySchema.safeParse('not-a-date').success).toBe(false);
  });
});
