import { describe, expect, it } from 'vitest';

import { editorStateResourcesSchema, userSettingsSchema } from '@/db/schema';

// Phase 1 (Repeated Word Check) extends the existing editor-state JSONB schema
// with two OPTIONAL keys and adds the user-global settings blob. These tests
// prove backward compatibility (old rows parse unchanged) and the new shapes.

const LEGACY_EDITOR_STATE = {
  activeResource: 'aquifer',
  bookCode: 'JDG',
  chapterNumber: 4,
  verseNumber: 3,
  languageCode: 'eng',
  tabStatus: true,
};

describe('editorStateResourcesSchema — Repeated Word Check extension', () => {
  it('parses a legacy row (no new keys) unchanged — backward compatible', () => {
    const parsed = editorStateResourcesSchema.parse(LEGACY_EDITOR_STATE);
    expect(parsed).toEqual(LEGACY_EDITOR_STATE);
  });

  it('still accepts null (the column is nullable)', () => {
    expect(editorStateResourcesSchema.parse(null)).toBeNull();
  });

  it('round-trips activeLeftTab and checkOccurrenceRules', () => {
    const withChecks = {
      ...LEGACY_EDITOR_STATE,
      activeLeftTab: 'checks' as const,
      checkOccurrenceRules: {
        'JDG 4:3|the the|0': 'suppress' as const,
        'JDG 4:3|and and|1': 'surface' as const,
      },
    };
    expect(editorStateResourcesSchema.parse(withChecks)).toEqual(withChecks);
  });

  it('rejects an invalid activeLeftTab value', () => {
    expect(() =>
      editorStateResourcesSchema.parse({ ...LEGACY_EDITOR_STATE, activeLeftTab: 'nope' })
    ).toThrow();
  });

  it('rejects an invalid occurrence-rule verdict', () => {
    expect(() =>
      editorStateResourcesSchema.parse({
        ...LEGACY_EDITOR_STATE,
        checkOccurrenceRules: { 'JDG 4:3|the the|0': 'ignore' },
      })
    ).toThrow();
  });
});

describe('userSettingsSchema — user-global settings blob (W8)', () => {
  it('parses an empty blob', () => {
    expect(userSettingsSchema.parse({})).toEqual({});
  });

  it('round-trips checkIgnoredWordPairs', () => {
    const blob = { checkIgnoredWordPairs: { 'the the': 'suppress' as const } };
    expect(userSettingsSchema.parse(blob)).toEqual(blob);
  });

  it('.catch({}) — an unknown/old top-level shape collapses to {} rather than throwing', () => {
    expect(userSettingsSchema.parse({ checkIgnoredWordPairs: 'not-a-record' })).toEqual({});
    expect(userSettingsSchema.parse('totally wrong')).toEqual({});
  });
});
