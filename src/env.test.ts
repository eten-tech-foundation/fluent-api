import { z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';

import { envInt } from './env';

describe('envInt', () => {
  const positive = z.object({ N: envInt(z.coerce.number().int().positive().default(7)) });
  const nonNegative = z.object({ H: envInt(z.coerce.number().int().min(0).default(1)) });

  it('applies the default when the var is unset', () => {
    expect(positive.parse({})).toEqual({ N: 7 });
  });

  it('treats blank and whitespace-only values as unset', () => {
    expect(positive.parse({ N: '' })).toEqual({ N: 7 });
    expect(positive.parse({ N: '   ' })).toEqual({ N: 7 });
  });

  it('parses integer strings', () => {
    expect(positive.parse({ N: '42' })).toEqual({ N: 42 });
  });

  it.each(['abc', '5.5', '-1', '0'])('rejects "%s" for positive vars', (value) => {
    expect(positive.safeParse({ N: value }).success).toBe(false);
  });

  it('accepts 0 where the rule is min(0)', () => {
    expect(nonNegative.parse({ H: '0' })).toEqual({ H: 0 });
  });

  it('rejects negatives even where 0 is allowed', () => {
    expect(nonNegative.safeParse({ H: '-1' }).success).toBe(false);
  });
});
