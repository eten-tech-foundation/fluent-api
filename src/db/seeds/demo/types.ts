import type { chapterStatusEnum, milestoneTypeEnum, projectStatusEnum } from '@/db/schema';

/**
 * Declarative demo-world spec, interpreted by `seedDemoSpec` in `engine.ts`.
 *
 * Specs are pure data — no DB ids, only keys. The engine resolves keys to ids
 * as it works (org key → organizations.id, user key → users.id, etc.) and all
 * writes are idempotent reconciles: create-if-missing, update-drifted-fields.
 */

export type DemoChapterStatus = (typeof chapterStatusEnum.enumValues)[number];
export type DemoMilestoneType = (typeof milestoneTypeEnum.enumValues)[number];
export type DemoMilestoneStatus = (typeof projectStatusEnum.enumValues)[number];

/** Org-scoped roles a spec user may hold inside one org. */
export type DemoOrgRole = 'Org Member' | 'Org Manager';
/** Project-scoped roles — always pinned to a project, never org-scoped. */
export type DemoProjectRole = 'Project Manager' | 'Project Translator' | 'Project Observer';
export type DemoGlobalRole = 'SuperAdmin';

export interface DemoOrganization {
  key: string;
  name: string;
}

export interface DemoLanguage {
  /** ISO-639-3 code — the reconcile key. */
  code: string;
  name: string;
  localizedName?: string;
}

export interface DemoBible {
  /** Reconcile key. */
  abbreviation: string;
  name: string;
  /** ISO-639-3 language code. */
  language: string;
  hasAudio?: boolean;
  /** Book codes to link via bible_books. */
  books?: string[];
}

export interface DemoUserOrg {
  /** Organization key. */
  org: string;
  /** Org-scoped roles beyond the automatic `Org Member` anchor. */
  roles: DemoOrgRole[];
}

export interface DemoUserProjectRole {
  /** Project key. */
  project: string;
  role: DemoProjectRole;
}

export interface DemoUser {
  key: string;
  email: string;
  username: string;
  firstName?: string;
  lastName?: string;
  /** Plaintext — dev/local only, never for network-reachable environments. */
  password?: string;
  /** Committed better-auth hash — written directly, no hashing at seed time. */
  passwordHash?: string;
  /** Orgs the user belongs to; each gets the `Org Member` anchor automatically. */
  orgs?: DemoUserOrg[];
  projectRoles?: DemoUserProjectRole[];
  globalRoles?: DemoGlobalRole[];
}

export interface DemoChapter {
  number: number;
  status: DemoChapterStatus;
  /** User key. */
  assignedTo?: string;
  /** User key. */
  peerChecker?: string;
  isAiEnabled?: boolean;
}

export interface DemoBook {
  /** Book code (e.g. 'GEN', 'MRK') — resolved to books.id. */
  code: string;
  chapters: DemoChapter[];
}

export interface DemoMilestone {
  key: string;
  /** project_units.name — required by the milestone model. */
  name: string;
  type?: DemoMilestoneType;
  status?: DemoMilestoneStatus;
  connectivityProfile?: string;
  books: DemoBook[];
}

export interface DemoProject {
  key: string;
  /** Organization key. */
  org: string;
  name: string;
  /** ISO-639-3 codes. */
  sourceLanguage: string;
  targetLanguage: string;
  /** Bible abbreviation — lands on projects.sourceBibleId and every book link. */
  sourceBible: string;
  /** pericope_sets name (e.g. 'FIA'). */
  pericopeSet?: string;
  milestones: DemoMilestone[];
}

export interface DemoSpec {
  /** Shared hash applied to any spec user without their own credential. */
  passwordHash?: string;
  languages?: DemoLanguage[];
  bibles?: DemoBible[];
  organizations: DemoOrganization[];
  users: DemoUser[];
  projects: DemoProject[];
}
