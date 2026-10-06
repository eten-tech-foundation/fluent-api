import { describe, expect, it } from 'vitest';

import type { DemoBook } from './types';

import { buildGrantPlan, PROJECT_SCOPED_ROLE_NAMES } from './grants';
import { QA_DEMO_PASSWORD_HASH, qaSpec } from './qa-spec';

function bookOf(projectKey: string, milestoneKey: string): DemoBook[] {
  const project = qaSpec.projects.find((p) => p.key === projectKey);
  const milestone = project?.milestones.find((m) => m.key === milestoneKey);
  return milestone?.books ?? [];
}

function statusCounts(books: DemoBook[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const book of books) {
    for (const ch of book.chapters) {
      counts[ch.status] = (counts[ch.status] ?? 0) + 1;
    }
  }
  return counts;
}

describe('qaSpec', () => {
  it('declares the four demo organizations', () => {
    expect(qaSpec.organizations.map((o) => o.key).sort()).toEqual([
      'fluent-qa',
      'highland',
      'new-horizons',
      'rivertown',
    ]);
  });

  it('seeds 17 users, all sharing the committed hash — no plaintext anywhere', () => {
    expect(qaSpec.users).toHaveLength(17);
    expect(qaSpec.passwordHash).toBe(QA_DEMO_PASSWORD_HASH);
    // better-auth scrypt format: <hex salt>:<hex hash>
    expect(QA_DEMO_PASSWORD_HASH).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    for (const user of qaSpec.users) {
      expect(user.password).toBeUndefined();
      expect(user.passwordHash).toBeUndefined();
    }
  });

  it('gives superadmin exactly one global grant and nothing else', () => {
    const plan = buildGrantPlan(qaSpec);
    expect(plan.filter((g) => g.userKey === 'superadmin')).toEqual([
      { userKey: 'superadmin', roleName: 'SuperAdmin', orgKey: null, projectKey: null },
    ]);
    expect(qaSpec.users.find((u) => u.key === 'superadmin')?.orgs ?? []).toHaveLength(0);
  });

  it('anchors every non-superadmin user with Org Member per declared org', () => {
    const plan = buildGrantPlan(qaSpec);
    for (const user of qaSpec.users.filter((u) => u.key !== 'superadmin')) {
      for (const entry of user.orgs ?? []) {
        expect(plan).toContainEqual({
          userKey: user.key,
          roleName: 'Org Member',
          orgKey: entry.org,
          projectKey: null,
        });
      }
    }
  });

  it('scopes every project-level role grant to org + project', () => {
    const plan = buildGrantPlan(qaSpec);
    const projectRoles = plan.filter((g) => PROJECT_SCOPED_ROLE_NAMES.has(g.roleName));
    expect(projectRoles.length).toBeGreaterThan(0);
    for (const grant of projectRoles) {
      expect(grant.projectKey).not.toBeNull();
      expect(grant.orgKey).not.toBeNull();
    }
  });

  it('makes hi-pm a project-scoped PM on all three projects across two orgs', () => {
    const plan = buildGrantPlan(qaSpec);
    const grants = plan.filter((g) => g.userKey === 'hi-pm' && g.roleName === 'Project Manager');
    expect(grants).toContainEqual({
      userKey: 'hi-pm',
      roleName: 'Project Manager',
      orgKey: 'highland',
      projectKey: 'highland-nt',
    });
    expect(grants).toContainEqual({
      userKey: 'hi-pm',
      roleName: 'Project Manager',
      orgKey: 'highland',
      projectKey: 'chichewa-obt',
    });
    expect(grants).toContainEqual({
      userKey: 'hi-pm',
      roleName: 'Project Manager',
      orgKey: 'rivertown',
      projectKey: 'wolof-epistles',
    });
    // …and carries the Org Member anchor in both orgs.
    expect(plan).toContainEqual({
      userKey: 'hi-pm',
      roleName: 'Org Member',
      orgKey: 'rivertown',
      projectKey: null,
    });
  });

  it('declares 3 projects / 4 milestones with the spec names and types', () => {
    expect(qaSpec.projects).toHaveLength(3);
    const milestones = qaSpec.projects.flatMap((p) => p.milestones);
    expect(milestones).toHaveLength(4);
    const audio = milestones.find((m) => m.type === 'audio');
    expect(audio?.name).toBe('Old Testament Narratives');
    expect(audio?.connectivityProfile).toBe('low-bandwidth');
    for (const project of qaSpec.projects) {
      expect(project.pericopeSet).toBe('FIA');
      expect(project.sourceBible).toMatch(/^(BSB|WEB)$/);
    }
  });

  it('distributes the chapter status matrix per the plan', () => {
    expect(statusCounts(bookOf('highland-nt', 'mark'))).toEqual({
      draft: 3,
      peer_check: 3,
      community_review: 3,
      linguist_check: 2,
      theological_check: 1,
      consultant_check: 1,
      complete: 3,
    });
    expect(statusCounts(bookOf('highland-nt', 'john'))).toEqual({
      draft: 4,
      peer_check: 4,
      community_review: 4,
      linguist_check: 2,
      theological_check: 1,
      consultant_check: 1,
      complete: 5,
    });
    expect(statusCounts(bookOf('chichewa-obt', 'ot-narratives'))).toEqual({
      draft: 2,
      peer_check: 2,
      community_review: 1,
      linguist_check: 1,
      consultant_check: 1,
      complete: 1,
    });
    expect(statusCounts(bookOf('wolof-epistles', 'james'))).toEqual({
      draft: 1,
      peer_check: 1,
      community_review: 1,
      consultant_check: 1,
      complete: 1,
    });
  });

  it('pairs hi-mt1 and hi-mt2 as peer checkers on every chapter they own', () => {
    for (const [projectKey, milestoneKey] of [
      ['highland-nt', 'mark'],
      ['highland-nt', 'john'],
      ['chichewa-obt', 'ot-narratives'],
    ] as const) {
      for (const book of bookOf(projectKey, milestoneKey)) {
        for (const ch of book.chapters) {
          if (ch.assignedTo === 'hi-mt1') expect(ch.peerChecker).toBe('hi-mt2');
          if (ch.assignedTo === 'hi-mt2') expect(ch.peerChecker).toBe('hi-mt1');
        }
      }
    }
  });

  it('uses lowercase emails — better-auth lowercases sign-in lookups', () => {
    for (const user of qaSpec.users) {
      expect(user.email).toBe(user.email.toLowerCase());
    }
  });

  it("numbers every book's chapters 1..N contiguously", () => {
    for (const project of qaSpec.projects) {
      for (const milestone of project.milestones) {
        for (const book of milestone.books) {
          expect(book.chapters.map((c) => c.number)).toEqual(
            Array.from({ length: book.chapters.length }, (_, i) => i + 1)
          );
        }
      }
    }
  });

  it('assigns every James chapter to rt-t', () => {
    for (const book of bookOf('wolof-epistles', 'james')) {
      for (const ch of book.chapters) {
        expect(ch.assignedTo).toBe('rt-t');
      }
    }
  });

  it('enables AI suggestions on Koli Kachi (gjk) chapters', () => {
    for (const milestone of qaSpec.projects.find((p) => p.key === 'highland-nt')!.milestones) {
      for (const book of milestone.books) {
        for (const ch of book.chapters) {
          expect(ch.isAiEnabled).toBe(true);
        }
      }
    }
  });

  it('upserts the demo languages and bibles with book links', () => {
    const languageCodes = (qaSpec.languages?.map((l) => l.code) ?? []).sort();
    expect(languageCodes).toEqual(['gjk', 'nya', 'wol']);
    const bibles = Object.fromEntries((qaSpec.bibles ?? []).map((b) => [b.abbreviation, b]));
    expect(bibles.BSB?.books?.sort()).toEqual(['JAS', 'JHN', 'MRK']);
    expect(bibles.WEB?.hasAudio).toBe(true);
    expect(bibles.WEB?.books?.sort()).toEqual(['JON', 'RUT']);
  });
});
