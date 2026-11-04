import { describe, expect, it } from 'vitest';

import { demoBiblePatch } from './bibles';

function existingBible(
  overrides: Partial<Parameters<typeof demoBiblePatch>[0]> = {}
): Parameters<typeof demoBiblePatch>[0] {
  return { externalId: 'web-01', hasAudio: true, audioResourceId: 7, ...overrides };
}

describe('demoBiblePatch (reseed of an adopted spec bible)', () => {
  it('leaves an operator-curated recording and hasAudio=false alone', () => {
    const bible = existingBible({ hasAudio: false, audioResourceId: 42 });

    expect(demoBiblePatch(bible, { externalId: 'web-01', hasAudio: true }, 7)).toEqual({});
  });

  it('fills the audio slot and hasAudio while no recording is selected', () => {
    const bible = existingBible({ hasAudio: false, audioResourceId: null });

    expect(demoBiblePatch(bible, { externalId: 'web-01', hasAudio: true }, 7)).toEqual({
      audioResourceId: 7,
      hasAudio: true,
    });
  });

  it('claims the spec externalId onto a row without one', () => {
    const bible = existingBible({ externalId: null });

    expect(demoBiblePatch(bible, { externalId: 'web-01' }, undefined)).toEqual({
      externalId: 'web-01',
    });
  });

  it('changes nothing when the spec omits externalId and audio', () => {
    const bible = existingBible({ externalId: null, audioResourceId: null });

    expect(demoBiblePatch(bible, {}, undefined)).toEqual({});
  });
});
