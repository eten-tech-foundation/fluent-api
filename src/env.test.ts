import { describe, expect, it } from 'vitest';

import { EnvSchema } from '@/env';

// Importing @/env has already loaded .env.test, so process.env is a known-valid
// environment. Stripping the R2_* keys leaves a base that satisfies every
// unconditional field, so each case below varies only the R2 block.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('R2_'))
);

const credentials = {
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
};

function bucketErrorKeys(input: Record<string, unknown>): string[] {
  const result = EnvSchema.safeParse(input);
  if (result.success) return [];
  return Object.keys(result.error.flatten().fieldErrors);
}

describe('r2 bucket names', () => {
  it('parses fine when R2 is not configured at all', () => {
    expect(EnvSchema.safeParse(baseEnv).success).toBe(true);
  });

  it('rejects R2 credentials without explicit bucket names', () => {
    // The whole point: no default to fall back on, so a deploy config that
    // forgot a bucket fails validation at boot instead of silently pointing at
    // another environment's bucket.
    expect(bucketErrorKeys({ ...baseEnv, ...credentials })).toEqual(
      expect.arrayContaining(['R2_EXPORTS_BUCKET', 'R2_AUDIO_BUCKET'])
    );
  });

  it('rejects a blank bucket name the same as a missing one', () => {
    // dotenv turns a bare `R2_AUDIO_BUCKET=` line into "", which .optional()
    // alone would happily accept.
    expect(
      bucketErrorKeys({
        ...baseEnv,
        ...credentials,
        R2_EXPORTS_BUCKET: 'fluent-exports-dev',
        R2_AUDIO_BUCKET: '',
      })
    ).toEqual(['R2_AUDIO_BUCKET']);
  });

  it('flags a partially configured R2 block too', () => {
    expect(bucketErrorKeys({ ...baseEnv, R2_ACCOUNT_ID: 'test-account' })).toEqual(
      expect.arrayContaining(['R2_EXPORTS_BUCKET', 'R2_AUDIO_BUCKET'])
    );
  });

  it('accepts R2 credentials when both buckets are named', () => {
    const result = EnvSchema.safeParse({
      ...baseEnv,
      ...credentials,
      R2_EXPORTS_BUCKET: 'fluent-exports-dev',
      R2_AUDIO_BUCKET: 'fluent-audio-recordings-dev',
    });

    expect(result.success).toBe(true);
    expect(result.data?.R2_AUDIO_BUCKET).toBe('fluent-audio-recordings-dev');
  });
});
