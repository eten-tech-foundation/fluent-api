import { and, eq, inArray } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import {
  bibles,
  books,
  chapter_assignments,
  languages,
  organizations,
  project_units,
  projects,
  users,
} from '@/db/schema';
import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import { createProject } from '@/domains/projects/projects.service';
import * as projectUsersRepo from '@/domains/projects/users/project-users.repository';

/** Idempotency marker — local Docker seeds only; never run against shared dev Postgres. */
const DEV_PROJECT_SEED_KEY = 'local-mobile-my-work';
const DEV_PROJECT_NAME = 'Local Dev — Mobile My Work';
const IRV_ABBREVIATION = 'IRV';
const IRV_BOOK_CODES = ['GEN', 'EXO'] as const;
const LANGUAGE_CODE = 'guj';
const FIRST_ASSIGNED_CHAPTER = { bookCode: 'GEN' as const, chapterNumber: 1 };

export async function seedDevProject() {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, 'Fluent Dev'))
    .limit(1);

  if (!org) {
    throw new Error('Default organization "Fluent Dev" not found. Run seedOrganizations first.');
  }

  const managerEmail = process.env.SEED_MANAGER_EMAIL ?? 'pm@fluent.local';
  const translatorEmail = process.env.SEED_TRANSLATOR_EMAIL ?? 't@fluent.local';

  const [manager] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, managerEmail))
    .limit(1);
  const [translator] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, translatorEmail))
    .limit(1);

  if (!manager) {
    throw new Error(`Manager user "${managerEmail}" not found. Run seedDevUsers first.`);
  }
  if (!translator) {
    throw new Error(`Translator user "${translatorEmail}" not found. Run seedDevUsers first.`);
  }

  const [language] = await db
    .select({ id: languages.id })
    .from(languages)
    .where(eq(languages.langCodeIso6393, LANGUAGE_CODE))
    .limit(1);

  if (!language) {
    throw new Error(`Language "${LANGUAGE_CODE}" not found. Run seedLanguages first.`);
  }

  const [bible] = await db
    .select({ id: bibles.id })
    .from(bibles)
    .where(eq(bibles.abbreviation, IRV_ABBREVIATION))
    .limit(1);

  if (!bible) {
    throw new Error(`Bible "${IRV_ABBREVIATION}" not found. Run seedBibles first.`);
  }

  const bookRows = await db
    .select({ id: books.id, code: books.code })
    .from(books)
    .where(inArray(books.code, [...IRV_BOOK_CODES]));

  const bookIdByCode = new Map<string, number>();
  for (const row of bookRows) {
    if (!bookIdByCode.has(row.code)) {
      bookIdByCode.set(row.code, row.id);
    }
  }

  const missingBooks = IRV_BOOK_CODES.filter((code) => !bookIdByCode.has(code));
  if (missingBooks.length > 0) {
    throw new Error(`Book(s) not found: ${missingBooks.join(', ')}. Run seedBooks first.`);
  }

  const bookIds = IRV_BOOK_CODES.map((code) => bookIdByCode.get(code) as number);

  const [existingProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.organization, org.id), eq(projects.name, DEV_PROJECT_NAME)))
    .limit(1);

  let projectId: number;

  if (existingProject) {
    projectId = existingProject.id;
    console.log(
      `Dev project "${DEV_PROJECT_NAME}" already exists (id=${projectId}) — ensuring membership and assignments.`
    );
  } else {
    const createResult = await createProject({
      name: DEV_PROJECT_NAME,
      sourceLanguage: language.id,
      targetLanguage: language.id,
      organization: org.id,
      createdBy: manager.id,
      bibleId: bible.id,
      bookId: bookIds,
      projectUnitStatus: 'not_started',
      metadata: { devSeedKey: DEV_PROJECT_SEED_KEY },
      isActive: true,
    });

    if (!createResult.ok) {
      throw new Error(
        createResult.error.message ?? 'Failed to create local dev project for mobile My Work.'
      );
    }

    projectId = createResult.data.id;
    console.log(`Created dev project "${DEV_PROJECT_NAME}" (id=${projectId}).`);
  }

  const membershipResult = await projectUsersRepo.addProjectUsers(projectId, [
    manager.id,
    translator.id,
  ]);
  if (!membershipResult.ok) {
    throw new Error(
      membershipResult.error.message ?? 'Failed to add dev users to local dev project.'
    );
  }

  const genBookId = bookIdByCode.get(FIRST_ASSIGNED_CHAPTER.bookCode);
  if (!genBookId) {
    throw new Error(`Book "${FIRST_ASSIGNED_CHAPTER.bookCode}" not found for assignment.`);
  }

  const [assignment] = await db
    .select({
      id: chapter_assignments.id,
      assignedUserId: chapter_assignments.assignedUserId,
      status: chapter_assignments.status,
    })
    .from(chapter_assignments)
    .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
    .where(
      and(
        eq(project_units.projectId, projectId),
        eq(chapter_assignments.bookId, genBookId),
        eq(chapter_assignments.chapterNumber, FIRST_ASSIGNED_CHAPTER.chapterNumber)
      )
    )
    .limit(1);

  if (!assignment) {
    throw new Error(
      `Chapter assignment for ${FIRST_ASSIGNED_CHAPTER.bookCode} ${FIRST_ASSIGNED_CHAPTER.chapterNumber} not found on dev project.`
    );
  }

  if (assignment.assignedUserId === translator.id && assignment.status === 'draft') {
    console.log(
      `Translator already assigned to ${FIRST_ASSIGNED_CHAPTER.bookCode} ${FIRST_ASSIGNED_CHAPTER.chapterNumber} (draft) — dev project seed complete.`
    );
    return;
  }

  const assignResult = await chapterAssignmentService.updateChapterAssignment(assignment.id, {
    assignedUserId: translator.id,
  });

  if (!assignResult.ok) {
    throw new Error(
      assignResult.error.message ??
        `Failed to assign ${FIRST_ASSIGNED_CHAPTER.bookCode} ${FIRST_ASSIGNED_CHAPTER.chapterNumber} to translator.`
    );
  }

  console.log(
    `Assigned ${FIRST_ASSIGNED_CHAPTER.bookCode} ${FIRST_ASSIGNED_CHAPTER.chapterNumber} to ${translatorEmail} (draft). Dev project seed complete.`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedDevProject()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
