import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { ASSISTANT_SAFETY_LIMITS } from './lib/output';
import { ASSISTANT_FRAME_BYTES, serializeAssistantFrame } from './lib/wire';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/frame-v1.json', import.meta.url), 'utf8')
);

it('shares an emitted whole-frame ceiling covering maximum answer escaping and envelope overhead', () => {
  expect(ASSISTANT_FRAME_BYTES).toBe(fixture.maximumFrameBytes);
  expect(ASSISTANT_FRAME_BYTES).toBe(
    6 * ASSISTANT_SAFETY_LIMITS.maximumAnswerBytes + fixture.envelopeReserveBytes
  );
  expect(ASSISTANT_FRAME_BYTES).toBeGreaterThan(8 * 1024 * 1024);
});

it('enforces the exact serialized boundary including JSON escaping, SSE fields and final separator', () => {
  const expected = `id: 1\nevent: turn_replace\ndata: ${JSON.stringify(fixture.event)}\n\n`;
  const bytes = Buffer.byteLength(expected);
  expect(serializeAssistantFrame(fixture.event, 1, bytes)).toBe(expected);
  expect(() => serializeAssistantFrame(fixture.event, 1, bytes - 1)).toThrow(
    'Assistant emitted frame exceeds limit'
  );
  expect(Buffer.byteLength(expected)).toBeGreaterThan(
    Buffer.byteLength(JSON.stringify(fixture.event))
  );
});
