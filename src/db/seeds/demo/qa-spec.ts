import type { DemoChapter, DemoSpec } from './types';

import { spread } from './spread';

/**
 * The shared QA demo password — generated once via `npm run db:hash-password`
 * and committed as a hash. Every one of the 17 spec accounts authenticates
 * with it; no plaintext credential exists anywhere for this environment.
 */
export const QA_DEMO_PASSWORD_HASH =
  '4ede61b5e1c2d41041e037adf324989b:832cec92cc5237d47b232c5ee5018f3b195aa71bb0e51a012090202b31ac77240cda872f4bbeed40401c48edff218f2e96c8bb8ec9841b189fa337602c5e713b';

const MOBILE_PAIR: [string, string] = ['hi-mt1', 'hi-mt2'];
const NT_TRANSLATORS = ['hi-t', 'hi-mt1', 'hi-mt2'];

/** Marks every chapter AI-enabled — Koli Kachi (gjk) is the AI-suggestions demo pair. */
const aiEnabled = (chapters: DemoChapter[]): DemoChapter[] =>
  chapters.map((ch) => ({ ...ch, isAiEnabled: true }));

/** Chapters for the Chichewa OBT milestone: the 8-chapter matrix split
 *  RUT 1-4 / JON 1-4 (each book carries a coherent workflow stage). */
function chichewaBooks(): { rut: DemoChapter[]; jon: DemoChapter[] } {
  const all = spread(
    8,
    [
      { status: 'draft', count: 2 },
      { status: 'peer_check', count: 2 },
      { status: 'community_review', count: 1 },
      { status: 'linguist_check', count: 1 },
      { status: 'consultant_check', count: 1 },
      { status: 'complete', count: 1 },
    ],
    [...MOBILE_PAIR],
    { peerPair: MOBILE_PAIR }
  );
  return {
    rut: all.slice(0, 4),
    jon: all.slice(4).map((ch, i) => ({ ...ch, number: i + 1 })),
  };
}

const chichewa = chichewaBooks();

/**
 * The full QA demo world — every account authenticates with the shared
 * password behind QA_DEMO_PASSWORD_HASH.
 */
export const qaSpec: DemoSpec = {
  passwordHash: QA_DEMO_PASSWORD_HASH,

  languages: [
    { code: 'nya', name: 'Chichewa', localizedName: 'Chichewa' },
    { code: 'wol', name: 'Wolof', localizedName: 'Wolof' },
    { code: 'gjk', name: 'Kachi Koli', localizedName: 'Kachi Koli' },
  ],

  bibles: [
    {
      abbreviation: 'BSB',
      name: 'Berean Standard Bible',
      language: 'eng',
      books: ['MRK', 'JHN', 'JAS'],
    },
    {
      abbreviation: 'WEB',
      name: 'World English Bible',
      language: 'eng',
      hasAudio: true,
      books: ['RUT', 'JON'],
    },
  ],

  organizations: [
    { key: 'fluent-qa', name: 'Fluent QA' },
    { key: 'highland', name: 'Highland Translation Alliance' },
    { key: 'rivertown', name: 'Rivertown Translation Team' },
    { key: 'new-horizons', name: 'New Horizons Translation Project' },
  ],

  users: [
    // ── Fluent QA — scratch org, no seeded projects ─────────────────────
    {
      key: 'qa-om',
      email: 'qa+fluentqa-om@fluent.local',
      username: 'qa-om',
      orgs: [{ org: 'fluent-qa', roles: ['Org Manager'] }],
    },
    {
      key: 'qa-pm',
      email: 'qa+fluentqa-pm@fluent.local',
      username: 'qa-pm',
      orgs: [{ org: 'fluent-qa', roles: [] }],
    },
    {
      key: 'qa-t1',
      email: 'qa+fluentqa-translator@fluent.local',
      username: 'qa-t1',
      orgs: [{ org: 'fluent-qa', roles: [] }],
    },
    {
      key: 'qa-t2',
      email: 'qa+fluentqa-translator2@fluent.local',
      username: 'qa-t2',
      orgs: [{ org: 'fluent-qa', roles: [] }],
    },
    {
      key: 'qa-obs',
      email: 'qa+fluentqa-observer@fluent.local',
      username: 'qa-obs',
      orgs: [{ org: 'fluent-qa', roles: [] }],
    },

    // ── SuperAdmin — global grant only, no org membership ────────────────
    {
      key: 'superadmin',
      email: 'cwhite@gloo.us',
      username: 'Chad White',
      globalRoles: ['SuperAdmin'],
    },

    // ── Highland Translation Alliance ───────────────────────────────────
    {
      key: 'hi-om',
      email: 'cwhite+highland-om@gloo.us',
      username: 'hi-om',
      orgs: [{ org: 'highland', roles: ['Org Manager'] }],
    },
    {
      key: 'hi-pm',
      email: 'cwhite+highland-pm@gloo.us',
      username: 'hi-pm',
      // Member of both orgs — PM on all three projects (cross-org switcher).
      orgs: [
        { org: 'highland', roles: [] },
        { org: 'rivertown', roles: [] },
      ],
      projectRoles: [
        { project: 'highland-nt', role: 'Project Manager' },
        { project: 'chichewa-obt', role: 'Project Manager' },
        { project: 'wolof-epistles', role: 'Project Manager' },
      ],
    },
    {
      key: 'hi-t',
      email: 'cwhite+highland-translator@gloo.us',
      username: 'hi-t',
      orgs: [{ org: 'highland', roles: [] }],
      projectRoles: [{ project: 'highland-nt', role: 'Project Translator' }],
    },
    {
      key: 'hi-obs',
      email: 'cwhite+highland-observer@gloo.us',
      username: 'hi-obs',
      orgs: [{ org: 'highland', roles: [] }],
      projectRoles: [
        { project: 'highland-nt', role: 'Project Observer' },
        { project: 'chichewa-obt', role: 'Project Observer' },
      ],
    },
    {
      key: 'hi-mt1',
      email: 'cwhite+highland-mob-t1@gloo.us',
      username: 'hi-mt1',
      orgs: [{ org: 'highland', roles: [] }],
      projectRoles: [
        { project: 'highland-nt', role: 'Project Translator' },
        { project: 'chichewa-obt', role: 'Project Translator' },
      ],
    },
    {
      key: 'hi-mt2',
      email: 'cwhite+highland-mob-t2@gloo.us',
      username: 'hi-mt2',
      orgs: [{ org: 'highland', roles: [] }],
      projectRoles: [
        { project: 'highland-nt', role: 'Project Translator' },
        { project: 'chichewa-obt', role: 'Project Translator' },
      ],
    },
    {
      key: 'hi-mobs',
      email: 'cwhite+highland-mob-obs@gloo.us',
      username: 'hi-mobs',
      orgs: [{ org: 'highland', roles: [] }],
      projectRoles: [
        { project: 'highland-nt', role: 'Project Observer' },
        { project: 'chichewa-obt', role: 'Project Observer' },
      ],
    },

    // ── Rivertown Translation Team ──────────────────────────────────────
    {
      key: 'rt-om',
      email: 'cwhite+rivertown-om@gloo.us',
      username: 'rt-om',
      orgs: [{ org: 'rivertown', roles: ['Org Manager'] }],
    },
    {
      key: 'rt-t',
      email: 'cwhite+rivertown-translator@gloo.us',
      username: 'rt-t',
      orgs: [{ org: 'rivertown', roles: [] }],
      projectRoles: [{ project: 'wolof-epistles', role: 'Project Translator' }],
    },
    {
      key: 'rt-obs',
      email: 'cwhite+rivertown-observer@gloo.us',
      username: 'rt-obs',
      orgs: [{ org: 'rivertown', roles: [] }],
      projectRoles: [{ project: 'wolof-epistles', role: 'Project Observer' }],
    },

    // ── New Horizons — OM only, first-run state ──────────────────────────
    {
      key: 'nh-om',
      email: 'cwhite+newhorizons-om@gloo.us',
      username: 'nh-om',
      orgs: [{ org: 'new-horizons', roles: ['Org Manager'] }],
    },
  ],

  projects: [
    {
      key: 'highland-nt',
      org: 'highland',
      name: 'Koli Kachi New Testament',
      sourceLanguage: 'eng',
      targetLanguage: 'gjk',
      sourceBible: 'BSB',
      pericopeSet: 'FIA',
      milestones: [
        {
          key: 'mark',
          name: 'Gospel of Mark',
          type: 'text',
          status: 'in_progress',
          books: [
            {
              code: 'MRK',
              chapters: aiEnabled(
                spread(
                  16,
                  [
                    { status: 'draft', count: 3 },
                    { status: 'peer_check', count: 3 },
                    { status: 'community_review', count: 3 },
                    { status: 'linguist_check', count: 2 },
                    { status: 'theological_check', count: 1 },
                    { status: 'consultant_check', count: 1 },
                    { status: 'complete', count: 3 },
                  ],
                  NT_TRANSLATORS,
                  { peerPair: MOBILE_PAIR }
                )
              ),
            },
          ],
        },
        {
          key: 'john',
          name: 'Gospel of John',
          type: 'text',
          status: 'in_progress',
          books: [
            {
              code: 'JHN',
              chapters: aiEnabled(
                spread(
                  21,
                  [
                    { status: 'draft', count: 4 },
                    { status: 'peer_check', count: 4 },
                    { status: 'community_review', count: 4 },
                    { status: 'linguist_check', count: 2 },
                    { status: 'theological_check', count: 1 },
                    { status: 'consultant_check', count: 1 },
                    { status: 'complete', count: 5 },
                  ],
                  NT_TRANSLATORS,
                  { peerPair: MOBILE_PAIR }
                )
              ),
            },
          ],
        },
      ],
    },
    {
      key: 'chichewa-obt',
      org: 'highland',
      name: 'Chichewa Oral Bible',
      sourceLanguage: 'eng',
      targetLanguage: 'nya',
      sourceBible: 'WEB',
      pericopeSet: 'FIA',
      milestones: [
        {
          key: 'ot-narratives',
          name: 'Old Testament Narratives',
          type: 'audio',
          status: 'in_progress',
          connectivityProfile: 'low-bandwidth',
          books: [
            { code: 'RUT', chapters: chichewa.rut },
            { code: 'JON', chapters: chichewa.jon },
          ],
        },
      ],
    },
    {
      key: 'wolof-epistles',
      org: 'rivertown',
      name: 'Wolof General Epistles',
      sourceLanguage: 'eng',
      targetLanguage: 'wol',
      sourceBible: 'BSB',
      pericopeSet: 'FIA',
      milestones: [
        {
          key: 'james',
          name: 'Book of James',
          type: 'text',
          status: 'in_progress',
          books: [
            {
              code: 'JAS',
              chapters: spread(
                5,
                [
                  { status: 'draft', count: 1 },
                  { status: 'peer_check', count: 1 },
                  { status: 'community_review', count: 1 },
                  { status: 'consultant_check', count: 1 },
                  { status: 'complete', count: 1 },
                ],
                ['rt-t']
              ),
            },
          ],
        },
      ],
    },
  ],
};
