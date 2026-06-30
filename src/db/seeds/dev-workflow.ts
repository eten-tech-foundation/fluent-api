import { and, eq, inArray, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
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

interface ChapterAssignmentSpec {
  bookCode: string;
  chapterNumber: number;
  assignedUserEmail?: string;
  peerCheckerEmail?: string;
}

interface DevWorkflowProjectSpec {
  seedKey: string;
  name: string;
  organizationName: string;
  bibleAbbreviation: string;
  bookCodes: string[];
  sourceLanguageCode: string;
  targetLanguageCode: string;
  createdByEmail: string;
  memberEmails: string[];
  chapterAssignments?: ChapterAssignmentSpec[];
}

interface DevWorkflowFile {
  projects: DevWorkflowProjectSpec[];
}

function loadDevWorkflow(): DevWorkflowFile {
  const raw = readFileSync(new URL('./data/dev-workflow.json', import.meta.url), 'utf-8');
  return JSON.parse(raw) as DevWorkflowFile;
}

function resolveDevUserEmail(email: string): string {
  if (email === '$SEED_MANAGER') {
    return process.env.SEED_MANAGER_EMAIL ?? 'pm@fluent.local';
  }
  if (email === '$SEED_TRANSLATOR') {
    return process.env.SEED_TRANSLATOR_EMAIL ?? 't@fluent.local';
  }
  return email;
}

async function resolveUserId(email: string): Promise<number> {
  const resolvedEmail = resolveDevUserEmail(email);
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, resolvedEmail))
    .limit(1);

  if (!user) {
    throw new Error(`User "${resolvedEmail}" not found. Run seedDevUsers first.`);
  }

  return user.id;
}

async function resolveLanguageId(code: string): Promise<number> {
  const [language] = await db
    .select({ id: languages.id })
    .from(languages)
    .where(eq(languages.langCodeIso6393, code))
    .limit(1);

  if (!language) {
    throw new Error(`Language "${code}" not found. Run seedLanguages first.`);
  }

  return language.id;
}

async function resolveBibleId(abbreviation: string): Promise<number> {
  const [bible] = await db
    .select({ id: bibles.id })
    .from(bibles)
    .where(eq(bibles.abbreviation, abbreviation))
    .limit(1);

  if (!bible) {
    throw new Error(`Bible "${abbreviation}" not found. Run seedBibles first.`);
  }

  return bible.id;
}

async function resolveBookIds(codes: string[]): Promise<Map<string, number>> {
  const bookRows = await db
    .select({ id: books.id, code: books.code })
    .from(books)
    .where(inArray(books.code, codes));

  const bookIdByCode = new Map<string, number>();
  for (const row of bookRows) {
    if (!bookIdByCode.has(row.code)) {
      bookIdByCode.set(row.code, row.id);
    }
  }

  const missing = codes.filter((code) => !bookIdByCode.has(code));
  if (missing.length > 0) {
    throw new Error(`Book(s) not found: ${missing.join(', ')}. Run seedBooks first.`);
  }

  return bookIdByCode;
}

async function ensureProject(
  spec: DevWorkflowProjectSpec,
  organizationId: number,
  bibleId: number,
  bookIdByCode: Map<string, number>,
  createdById: number
): Promise<number> {
  const [existingProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(sql`${projects.metadata}->>'devSeedKey' = ${spec.seedKey}`)
    .limit(1);

  if (existingProject) {
    console.log(
      `Dev workflow project "${spec.name}" already exists (id=${existingProject.id}, seedKey=${spec.seedKey}).`
    );
    return existingProject.id;
  }

  const bookIds = spec.bookCodes.map((code) => bookIdByCode.get(code) as number);
  const sourceLanguageId = await resolveLanguageId(spec.sourceLanguageCode);
  const targetLanguageId = await resolveLanguageId(spec.targetLanguageCode);

  const createResult = await createProject({
    name: spec.name,
    sourceLanguage: sourceLanguageId,
    targetLanguage: targetLanguageId,
    organization: organizationId,
    createdBy: createdById,
    bibleId,
    bookId: bookIds,
    projectUnitStatus: 'not_started',
    metadata: { devSeedKey: spec.seedKey },
    isActive: true,
  });

  if (!createResult.ok) {
    throw new Error(
      createResult.error.message ?? `Failed to create dev workflow project "${spec.name}".`
    );
  }

  console.log(`Created dev workflow project "${spec.name}" (id=${createResult.data.id}).`);
  return createResult.data.id;
}

async function ensureChapterAssignments(
  projectId: number,
  bookIdByCode: Map<string, number>,
  assignments: ChapterAssignmentSpec[]
): Promise<void> {
  for (const assignmentSpec of assignments) {
    const bookId = bookIdByCode.get(assignmentSpec.bookCode);
    if (!bookId) {
      throw new Error(`Book "${assignmentSpec.bookCode}" not found for chapter assignment.`);
    }

    const [assignment] = await db
      .select({
        id: chapter_assignments.id,
        assignedUserId: chapter_assignments.assignedUserId,
        peerCheckerId: chapter_assignments.peerCheckerId,
        status: chapter_assignments.status,
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .where(
        and(
          eq(project_units.projectId, projectId),
          eq(chapter_assignments.bookId, bookId),
          eq(chapter_assignments.chapterNumber, assignmentSpec.chapterNumber)
        )
      )
      .limit(1);

    if (!assignment) {
      throw new Error(
        `Chapter assignment for ${assignmentSpec.bookCode} ${assignmentSpec.chapterNumber} not found on project ${projectId}.`
      );
    }

    const updateData: {
      assignedUserId?: number;
      peerCheckerId?: number;
    } = {};

    if (assignmentSpec.assignedUserEmail) {
      const assignedUserId = await resolveUserId(assignmentSpec.assignedUserEmail);
      if (assignment.assignedUserId !== assignedUserId || assignment.status === 'not_started') {
        updateData.assignedUserId = assignedUserId;
      }
    }

    if (assignmentSpec.peerCheckerEmail) {
      const peerCheckerId = await resolveUserId(assignmentSpec.peerCheckerEmail);
      if (assignment.peerCheckerId !== peerCheckerId) {
        updateData.peerCheckerId = peerCheckerId;
      }
    }

    if (Object.keys(updateData).length === 0) {
      console.log(
        `Chapter ${assignmentSpec.bookCode} ${assignmentSpec.chapterNumber} already matches dev-workflow spec — skipping.`
      );
      continue;
    }

    const assignResult = await chapterAssignmentService.updateChapterAssignment(
      assignment.id,
      updateData
    );

    if (!assignResult.ok) {
      throw new Error(
        assignResult.error.message ??
          `Failed to apply dev-workflow assignment for ${assignmentSpec.bookCode} ${assignmentSpec.chapterNumber}.`
      );
    }

    console.log(
      `Applied dev-workflow assignment for ${assignmentSpec.bookCode} ${assignmentSpec.chapterNumber}.`
    );
  }
}

async function seedDevWorkflowProject(spec: DevWorkflowProjectSpec): Promise<void> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, spec.organizationName))
    .limit(1);

  if (!org) {
    throw new Error(
      `Organization "${spec.organizationName}" not found. Run seedOrganizations first.`
    );
  }

  const bibleId = await resolveBibleId(spec.bibleAbbreviation);
  const bookIdByCode = await resolveBookIds(spec.bookCodes);
  const createdById = await resolveUserId(spec.createdByEmail);
  const memberIds = await Promise.all(spec.memberEmails.map((email) => resolveUserId(email)));

  const projectId = await ensureProject(spec, org.id, bibleId, bookIdByCode, createdById);

  const membershipResult = await projectUsersRepo.addProjectUsers(projectId, memberIds);
  if (!membershipResult.ok) {
    throw new Error(
      membershipResult.error.message ??
        `Failed to add members to dev workflow project "${spec.name}".`
    );
  }

  if (spec.chapterAssignments?.length) {
    await ensureChapterAssignments(projectId, bookIdByCode, spec.chapterAssignments);
  }
}

/** Idempotent local-dev workflow seed — driven by `data/dev-workflow.json`. Local Docker only. */
export async function seedDevWorkflow() {
  const { projects: projectSpecs } = loadDevWorkflow();

  if (projectSpecs.length === 0) {
    console.log('Dev workflow seed: no projects declared — skipping.');
    return;
  }

  for (const spec of projectSpecs) {
    await seedDevWorkflowProject(spec);
  }

  console.log(`Dev workflow seeded (${projectSpecs.length} project(s)).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedDevWorkflow()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
