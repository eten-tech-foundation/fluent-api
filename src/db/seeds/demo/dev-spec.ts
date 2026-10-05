import type { DemoSpec } from './types';

import { spread } from './spread';

export interface DevUserCredential {
  email: string;
  username: string;
  password?: string;
  passwordHash?: string;
}

export interface DevCredentials {
  pm: DevUserCredential;
  translators: DevUserCredential[];
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
    users: [
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
