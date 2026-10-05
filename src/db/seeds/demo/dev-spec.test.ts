import { describe, expect, it } from 'vitest';

import { devSpec } from './dev-spec';

const creds = {
  pm: { email: 'pm@example.com', username: 'devpm', password: 'pm-pass' },
  translators: [
    { email: 't1@example.com', username: 'translator', password: 't-pass' },
    { email: 't2@example.com', username: 'translator2', password: 't-pass' },
  ],
};

describe('devSpec', () => {
  const spec = devSpec(creds);

  it('describes the Fluent Dev org', () => {
    expect(spec.organizations).toEqual([{ key: 'fluent-dev', name: 'Fluent Dev' }]);
  });

  it('gives the PM a project-scoped Project Manager grant and translators project-scoped Translator grants', () => {
    const [pm, t1, t2] = spec.users;
    expect(pm.projectRoles).toEqual([
      { project: 'guj-gen-exo', role: 'Project Manager' },
    ]);
    for (const t of [t1, t2]) {
      expect(t.projectRoles).toEqual([
        { project: 'guj-gen-exo', role: 'Project Translator' },
      ]);
    }
    // Every spec user is a member of the Fluent Dev org (anchor added by the engine).
    for (const u of spec.users) {
      expect(u.orgs).toEqual([{ org: 'fluent-dev', roles: ['Org Member'] }]);
    }
  });

  it('passes credentials through to the spec users', () => {
    const [pm, t1] = spec.users;
    expect(pm.email).toBe('pm@example.com');
    expect(pm.password).toBe('pm-pass');
    expect(t1.password).toBe('t-pass');
  });

  it('describes one Gujarati→English project with a single text milestone holding GEN+EXO', () => {
    expect(spec.projects).toHaveLength(1);
    const project = spec.projects[0];
    expect(project).toMatchObject({
      org: 'fluent-dev',
      name: 'Gujarati → English — Genesis & Exodus',
      sourceLanguage: 'guj',
      targetLanguage: 'eng',
      sourceBible: 'IRV',
      pericopeSet: 'FIA',
    });
    expect(project.milestones).toHaveLength(1);
    const milestone = project.milestones[0];
    expect(milestone.type).toBe('text');
    expect(milestone.books.map((b) => b.code)).toEqual(['GEN', 'EXO']);
  });

  it('spreads chapters across the translators with only draft/peer_check/complete statuses', () => {
    const [gen, exo] = spec.projects[0].milestones[0].books;
    expect(gen.chapters).toHaveLength(50);
    expect(exo.chapters).toHaveLength(40);
    const all = [...gen.chapters, ...exo.chapters];
    expect(new Set(all.map((c) => c.status))).toEqual(
      new Set(['complete', 'peer_check', 'draft'])
    );
    expect(all.every((c) => c.assignedTo === 'translator' || c.assignedTo === 'translator2')).toBe(
      true
    );
  });
});
