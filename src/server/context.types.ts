import type { ChapterAssignmentWithAuthContext } from '@/domains/chapter-assignments/chapter-assignments.repository';
import type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';
import type { TranslatedVerseResponse } from '@/domains/translated-verses/translated-verses.types';
import type { UserResponse } from '@/domains/users/users.types';
import type { AppBindings } from '@/lib/types';

export interface AppEnv extends AppBindings {
  Variables: AppBindings['Variables'] & {
    chapterAssignment?: ChapterAssignmentWithAuthContext;
    project?: ProjectWithLanguageNames;
    projectAuthContext?: { isProjectMember: boolean };
    targetUser?: UserResponse;
    translatedVerse?: TranslatedVerseResponse;
  };
}
