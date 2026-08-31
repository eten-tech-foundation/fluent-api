import { vi } from 'vitest';

import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { ok } from '@/lib/types';

export const APP_USER = {
  id: 1,
  email: 'translator@example.com',
  role: 5,
  roleName: 'Translator',
  organization: 1,
  status: 'verified' as 'verified' | 'inactive',
};

export const MOCK_PROJECT = {
  id: 10,
  name: 'Test Project',
  organization: 1,
};

export const NOTES_PATH = '/projects/10/translation-resources/notes/MRK/14/1?languageCode=eng';
export const QUESTIONS_PATH =
  '/projects/10/translation-resources/questions/MRK/14/1?languageCode=eng';
export const IMAGES_PATH = '/projects/10/translation-resources/images/MRK/14/1?languageCode=eng';
export const MANIFEST_PATH =
  '/projects/10/translation-resources/manifest?languageCode=eng&bookCode=MRK&startChapter=14&endChapter=14';

export function asAuthenticatedUser(
  overrides: Partial<typeof APP_USER> = {},
  grantedPermission = true
) {
  const user = { ...APP_USER, ...overrides };
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: user.email },
  });
  (getUserByEmail as any).mockResolvedValue(ok(user));
  // orgId/projectId intentionally don't match MOCK_PROJECT: this grant satisfies the
  // route-level requirePermission gate without blanket-authorizing project access, so
  // ProjectPolicy.read still falls through to the isProjectMember check in tests below.
  (findGrantsByUserId as any).mockResolvedValue(
    ok(
      grantedPermission
        ? [{ orgId: 999, projectId: 999, permissions: new Set([PERMISSIONS.PROJECT_VIEW]) }]
        : []
    )
  );
}

export function asProjectMember() {
  vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
  vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
}

export const searchHit = {
  id: 101,
  name: 'faith',
  localizedName: 'Faith',
  mediaType: 'Text' as const,
  languageCode: 'eng',
  grouping: {
    type: 'Guide' as const,
    name: 'Translation Notes',
    collectionTitle: 'Translation Notes',
    collectionCode: 'UWTranslationNotes',
  },
};

export const textDetails = {
  id: 101,
  referenceId: 101,
  name: 'faith',
  localizedName: 'Faith',
  content: [{ tiptap: { type: 'doc', content: [{ type: 'paragraph' }] } }],
  grouping: { type: 'Guide' as const, name: 'Guide', mediaType: 'Text' },
  language: { id: 1, code: 'eng', displayName: 'English', scriptDirection: 'LTR' },
};

export function imageSearchHit(id: number) {
  return {
    ...searchHit,
    id,
    mediaType: 'Image' as const,
    grouping: {
      type: 'Images' as const,
      name: 'Images',
      collectionTitle: 'Images',
      collectionCode: 'Images',
    },
  };
}
