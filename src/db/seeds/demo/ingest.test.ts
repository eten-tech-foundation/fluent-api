import { describe, expect, it } from 'vitest';

import type { DemoSpec } from './types';

import { planIngestJobs } from './ingest';

const spec: DemoSpec = {
  organizations: [{ key: 'org', name: 'Org' }],
  users: [],
  projects: [
    {
      key: 'proj-a',
      org: 'org',
      name: 'Project A',
      sourceLanguage: 'eng',
      targetLanguage: 'nya',
      sourceBible: 'BSB',
      milestones: [
        {
          key: 'ms-1',
          name: 'Milestone 1',
          books: [
            { code: 'MRK', chapters: [{ number: 1, status: 'not_started' }] },
            { code: 'JHN', chapters: [{ number: 1, status: 'not_started' }] },
          ],
        },
        {
          key: 'ms-2',
          name: 'Milestone 2',
          books: [{ code: 'JAS', chapters: [{ number: 1, status: 'not_started' }] }],
        },
      ],
    },
    {
      key: 'proj-b',
      org: 'org',
      name: 'Project B',
      sourceLanguage: 'eng',
      targetLanguage: 'wol',
      sourceBible: 'WEB',
      milestones: [
        {
          key: 'ms-3',
          name: 'Milestone 3',
          books: [{ code: 'RUT', chapters: [{ number: 1, status: 'not_started' }] }],
        },
      ],
    },
  ],
};

const externalIds = new Map<string, string | null>([
  ['BSB', 'bba9f40183526463-01'],
  ['WEB', '9879dbb7cfe39e4d-01'],
]);

const noText = () => false;

describe('planIngestJobs', () => {
  it('batches every missing-text book into one job per milestone', () => {
    expect(planIngestJobs(spec, noText, externalIds)).toEqual([
      { projectKey: 'proj-a', milestoneKey: 'ms-1', bibleAbbrev: 'BSB', bookCodes: ['MRK', 'JHN'] },
      { projectKey: 'proj-a', milestoneKey: 'ms-2', bibleAbbrev: 'BSB', bookCodes: ['JAS'] },
      { projectKey: 'proj-b', milestoneKey: 'ms-3', bibleAbbrev: 'WEB', bookCodes: ['RUT'] },
    ]);
  });

  it('skips books that already have bible text', () => {
    const hasText = (bible: string, code: string) => bible === 'BSB' && code === 'JHN';
    expect(planIngestJobs(spec, hasText, externalIds)).toEqual([
      { projectKey: 'proj-a', milestoneKey: 'ms-1', bibleAbbrev: 'BSB', bookCodes: ['MRK'] },
      { projectKey: 'proj-a', milestoneKey: 'ms-2', bibleAbbrev: 'BSB', bookCodes: ['JAS'] },
      { projectKey: 'proj-b', milestoneKey: 'ms-3', bibleAbbrev: 'WEB', bookCodes: ['RUT'] },
    ]);
  });

  it('emits a milestone only when at least one book needs text', () => {
    const hasText = (bible: string, _code: string) => bible === 'BSB';
    expect(planIngestJobs(spec, hasText, externalIds)).toEqual([
      { projectKey: 'proj-b', milestoneKey: 'ms-3', bibleAbbrev: 'WEB', bookCodes: ['RUT'] },
    ]);
  });

  it('returns no jobs when every book is already ingested — idempotent re-run', () => {
    expect(planIngestJobs(spec, () => true, externalIds)).toEqual([]);
  });

  it('drops milestones whose bible has no DBL externalId — a doomed job would just retry-spam', () => {
    const ids = new Map(externalIds);
    ids.set('WEB', null);
    expect(planIngestJobs(spec, noText, ids)).toEqual([
      { projectKey: 'proj-a', milestoneKey: 'ms-1', bibleAbbrev: 'BSB', bookCodes: ['MRK', 'JHN'] },
      { projectKey: 'proj-a', milestoneKey: 'ms-2', bibleAbbrev: 'BSB', bookCodes: ['JAS'] },
    ]);
    ids.delete('WEB');
    expect(planIngestJobs(spec, noText, ids).map((j) => j.milestoneKey)).toEqual(['ms-1', 'ms-2']);
  });
});
