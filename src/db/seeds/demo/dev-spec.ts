import type { DemoSpec } from './types';

import { IRV_BIBLE, IRV_BOOK_CODES } from '../reference-bibles';
import { spread } from './spread';

interface DevUserCredential {
  email: string;
  username: string;
  password?: string;
  passwordHash?: string;
}

interface DevCredentials {
  pm: DevUserCredential;
  translators: DevUserCredential[];
  /** Optional SuperAdmin account (local keeps one as a committed default). */
  superadmin?: DevUserCredential;
  /** Optional Org Manager for the dev org. */
  orgManager?: DevUserCredential;
}

const PROJECT_KEY = 'guj-gen-exo';
const ORG_KEY = 'fluent-dev';
const ORG_NAME = 'Fluent Dev';

/**
 * The shared Dev/Local spec: the `Fluent Dev` org, a PM and translator roster
 * re-granted to the correct scoped model, and one IRV-sourced project so dev
 * gets a working source panel with zero new seed data files.
 */
export function devSpec(creds: DevCredentials): DemoSpec {
  // First two translators peer-check each other's peer_check chapters.
  const peerPair: [string, string] | undefined =
    creds.translators.length >= 2
      ? [creds.translators[0].username, creds.translators[1].username]
      : undefined;
  const translatorKeys = creds.translators.map((t) => t.username);

  return {
    organizations: [{ key: ORG_KEY, name: ORG_NAME }],
    // The project resolves `sourceBible: 'IRV'` by upstream identity, not bare
    // abbreviation — declaring it here keeps the project pinned to the real
    // IRV row even where 'IRV' is a catalogue-synced foreign row (or missing).
    // ttsLicenseStatus/licenseNotice must match what seeds/bibles.ts writes,
    // because the spec's provider-resource upsert overwrites them on conflict.
    bibles: [
      {
        abbreviation: IRV_BIBLE.abbreviation,
        name: IRV_BIBLE.name,
        language: IRV_BIBLE.languageCode,
        externalId: IRV_BIBLE.externalId,
        audioExternalId: IRV_BIBLE.audioExternalId,
        hasAudio: true,
        ttsLicenseStatus: 'allowed',
        licenseNotice: IRV_BIBLE.licenseNotice,
        books: [...IRV_BOOK_CODES],
      },
    ],
    users: [
      ...(creds.superadmin
        ? [
            {
              key: creds.superadmin.username,
              email: creds.superadmin.email,
              username: creds.superadmin.username,
              lastName: '(Dev)',
              password: creds.superadmin.password,
              passwordHash: creds.superadmin.passwordHash,
              globalRoles: ['SuperAdmin' as const],
            },
          ]
        : []),
      ...(creds.orgManager
        ? [
            {
              key: creds.orgManager.username,
              email: creds.orgManager.email,
              username: creds.orgManager.username,
              lastName: '(Dev)',
              password: creds.orgManager.password,
              passwordHash: creds.orgManager.passwordHash,
              orgs: [{ org: ORG_KEY, roles: ['Org Manager' as const] }],
            },
          ]
        : []),
      {
        key: creds.pm.username,
        email: creds.pm.email,
        username: creds.pm.username,
        lastName: '(Dev)',
        password: creds.pm.password,
        passwordHash: creds.pm.passwordHash,
        orgs: [{ org: ORG_KEY, roles: ['Org Member'] }],
        projectRoles: [{ project: PROJECT_KEY, role: 'Project Manager' }],
      },
      ...creds.translators.map((t) => ({
        key: t.username,
        email: t.email,
        username: t.username,
        lastName: '(Dev)',
        password: t.password,
        passwordHash: t.passwordHash,
        orgs: [{ org: ORG_KEY, roles: ['Org Member' as const] }],
        projectRoles: [{ project: PROJECT_KEY, role: 'Project Translator' as const }],
      })),
    ],
    projects: [
      {
        key: PROJECT_KEY,
        org: ORG_KEY,
        name: 'Gujarati → English — Genesis & Exodus',
        sourceLanguage: 'guj',
        targetLanguage: 'eng',
        sourceBible: 'IRV',
        pericopeSet: 'FIA',
        milestones: [
          {
            key: 'gen-exo',
            name: 'Genesis & Exodus',
            type: 'text',
            status: 'in_progress',
            books: [
              {
                code: 'GEN',
                chapters: spread(
                  50,
                  [
                    { status: 'complete', count: 20 },
                    { status: 'peer_check', count: 15 },
                    { status: 'draft', count: 15 },
                  ],
                  translatorKeys,
                  { peerPair }
                ),
              },
              {
                code: 'EXO',
                chapters: spread(
                  40,
                  [
                    { status: 'complete', count: 10 },
                    { status: 'peer_check', count: 14 },
                    { status: 'draft', count: 16 },
                  ],
                  translatorKeys,
                  { peerPair }
                ),
              },
            ],
          },
        ],
      },
    ],
  };
}
