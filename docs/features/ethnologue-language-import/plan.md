# Ethnologue Language Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR #257's seed-script approach to importing Ethnologue language data with a standalone, reusable, tested import path that doesn't touch the existing dev seed chain.

**Architecture:** A schema migration adds a unique constraint on `languages.lang_code_iso_639_3` and widens the name columns to `varchar(255)`. Pure parsing/RTL-detection helpers and two DB-touching import functions live under `src/domains/languages/import/`, each taking raw file content (not a path) so they're callable from something other than a CLI later. Two thin CLI scripts under `src/db/scripts/` read a file path from `argv`, call the corresponding function, and print the returned summary.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Vitest, tsx (CLI script runner) — all already used in this repo, no new dependencies.

## Global Constraints

- Do not modify `src/db/seeds/languages.ts` or `src/db/seeds/data/languages.json` — the existing dev-fixture seeder must keep working unchanged and stay wired into `db:setup`.
- `languages.lang_code_iso_639_3` gets a plain `UNIQUE` constraint (NULLs unrestricted) — use Drizzle's inline `.unique()`, matching how other unique columns are declared in `src/db/schema.ts` (e.g. `bibles.name`).
- `languages.lang_name` and `languages.lang_name_localized` become `varchar(255)` — matches `bibles.name` / `organizations.name` convention.
- Never truncate an oversized name — reject (throw) instead, naming the offending code.
- Import is insert-only: existing rows are never updated or deleted by the import function. The enrichment function only ever fills a currently-`NULL` `lang_name_localized`, never overwrites one.
- Domain functions (`src/domains/languages/import/*.ts`, excluding tests) take file **content** as a string argument — never `node:fs`, never a file path. Filesystem access is confined to the CLI wrapper scripts in `src/db/scripts/`.
- Follow this repo's existing lint conventions: `eslint.config.mjs` disables `no-console` only for `src/db/scripts/**` and `src/db/seeds/**` — domain modules must not use `console.*`; they communicate via return values and thrown errors.
- File names use kebab-case (enforced by `unicorn/filename-case`).
- Do not commit anything to git — this session's changes are left uncommitted for the user to review.
- Do not run `npm run db:migrate` against a real/shared database — only `npm run db:generate` (schema-diff only, no DB connection) is required to produce the migration file. If verifying the migration applies cleanly, do so only against the local dev Postgres from `compose.yaml`, and say so explicitly when you do.

---

### Task 1: Schema migration — unique constraint and widened name columns

**Files:**

- Modify: `src/db/schema.ts:163-173` (the `languages` table definition)
- Create: `src/db/migrations/00XX_<generated-name>.sql` (via `drizzle-kit generate`, not hand-written)

**Interfaces:**

- Consumes: nothing (schema-only change).
- Produces: `languages.langCodeIso6393` is now a unique Drizzle column; `languages.langName` / `languages.langNameLocalized` accept up to 255 characters. Later tasks that insert/update these columns rely on the 255-char limit — inserting or updating with a value over 255 chars must be rejected by application code before it ever reaches the DB (per Global Constraints), but the DB column itself now also permits up to 255.

- [ ] **Step 1: Update the `languages` table definition**

In `src/db/schema.ts`, change:

```ts
export const languages = pgTable('languages', {
  id: serial('id').primaryKey(),
  langName: varchar('lang_name', { length: 100 }).notNull(),
  langNameLocalized: varchar('lang_name_localized', { length: 100 }),
  langCodeIso6393: varchar('lang_code_iso_639_3', { length: 3 }),
  scriptDirection: scriptDirectionEnum('script_direction').default('ltr'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});
```

to:

```ts
export const languages = pgTable('languages', {
  id: serial('id').primaryKey(),
  langName: varchar('lang_name', { length: 255 }).notNull(),
  langNameLocalized: varchar('lang_name_localized', { length: 255 }),
  langCodeIso6393: varchar('lang_code_iso_639_3', { length: 3 }).unique(),
  scriptDirection: scriptDirectionEnum('script_direction').default('ltr'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate add_languages_unique_code_and_widen_names`

Expected: a new file `src/db/migrations/00XX_add_languages_unique_code_and_widen_names.sql` is created (number follows the highest existing one, currently `0014`), and `src/db/migrations/meta/_journal.json` is updated automatically. Do not rename the generated file.

- [ ] **Step 3: Verify the generated SQL**

Read the generated `.sql` file and confirm it contains, in some order:

- An `ALTER TABLE "languages" ALTER COLUMN "lang_name" SET DATA TYPE varchar(255);` (or equivalent widening statement for `lang_name`)
- The same widening for `lang_name_localized`
- An `ADD CONSTRAINT ... UNIQUE("lang_code_iso_639_3")` statement

If any of these three are missing, the schema edit in Step 1 didn't apply as intended — fix the schema and regenerate (delete the wrongly-generated migration file and its `meta` snapshot first).

- [ ] **Step 4 (optional, local verification only): apply against local dev Postgres**

Only if a local Postgres from `compose.yaml` is already running for this repo. Run: `npm run db:migrate`. Expected: migration applies without error. If it fails with a uniqueness violation, it means the local dev DB already has duplicate `lang_code_iso_639_3` values — this is a pre-existing local data problem, not a bug in this migration; do not work around it in code, just note it if it happens.

- [ ] **Step 5: Do not commit**

Leave `src/db/schema.ts` and the new migration files modified/untracked. Do not run `git add` or `git commit`.

---

### Task 2: CSV parsing helpers

**Files:**

- Create: `src/domains/languages/import/csv.ts`
- Test: `src/domains/languages/import/csv.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `detectDelimiter(headerLine: string): string`
  - `parseLine(line: string, delimiter: string): string[]`
  - `interface ParsedCsv { headers: string[]; rows: string[][] }`
  - `parseCsv(content: string): ParsedCsv`
  - These are consumed by Task 4 (`import-ethnologue.ts`) and Task 5 (`enrich-localized-names.ts`), both of which call only `parseCsv`.

- [ ] **Step 1: Write the failing tests**

Create `src/domains/languages/import/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { detectDelimiter, parseCsv, parseLine } from './csv';

describe('detectDelimiter', () => {
  it('detects tab delimiter when header contains a tab', () => {
    expect(detectDelimiter('LangID\tName')).toBe('\t');
  });

  it('defaults to comma when header has no tab', () => {
    expect(detectDelimiter('LangID,Name')).toBe(',');
  });
});

describe('parseLine', () => {
  it('splits a simple comma-delimited line', () => {
    expect(parseLine('aaa,Test Language,US', ',')).toEqual(['aaa', 'Test Language', 'US']);
  });

  it('keeps commas inside quoted fields intact', () => {
    expect(parseLine('aaa,"Language, With Comma",US', ',')).toEqual([
      'aaa',
      'Language, With Comma',
      'US',
    ]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseLine('aaa,"Say ""Hi""",US', ',')).toEqual(['aaa', 'Say "Hi"', 'US']);
  });

  it('splits on tabs when given a tab delimiter', () => {
    expect(parseLine('aaa\tTest Language\tUS', '\t')).toEqual(['aaa', 'Test Language', 'US']);
  });
});

describe('parseCsv', () => {
  it('parses headers as lowercase and trimmed, and rows as string arrays', () => {
    const content = 'LangID,Name,Country\naaa,Test Language,US\nbbb,Other Language,FR\n';
    expect(parseCsv(content)).toEqual({
      headers: ['langid', 'name', 'country'],
      rows: [
        ['aaa', 'Test Language', 'US'],
        ['bbb', 'Other Language', 'FR'],
      ],
    });
  });

  it('auto-detects a tab-delimited file', () => {
    const content = 'ISO_639\tPrint_Name\naaa\tAutonym One\n';
    expect(parseCsv(content)).toEqual({
      headers: ['iso_639', 'print_name'],
      rows: [['aaa', 'Autonym One']],
    });
  });

  it('skips blank lines', () => {
    const content = 'LangID,Name\naaa,Test Language\n\nbbb,Other Language\n';
    expect(parseCsv(content).rows).toHaveLength(2);
  });

  it('returns empty headers and rows when the file has fewer than 2 lines', () => {
    expect(parseCsv('LangID,Name\n')).toEqual({ headers: [], rows: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- csv.test.ts`
Expected: FAIL — `Cannot find module './csv'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/domains/languages/import/csv.ts`:

```ts
export function detectDelimiter(headerLine: string): string {
  return headerLine.includes('\t') ? '\t' : ',';
}

export function parseLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function parseCsv(content: string): ParsedCsv {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return { headers: [], rows: [] };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseLine(lines[0], delimiter).map((header) => header.trim().toLowerCase());
  const rows = lines.slice(1).map((line) => parseLine(line.trim(), delimiter));

  return { headers, rows };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- csv.test.ts`
Expected: PASS (all cases in Step 1).

- [ ] **Step 5: Lint and typecheck**

Run: `npm run lint:fix -- src/domains/languages/import/csv.ts src/domains/languages/import/csv.test.ts && npm run typecheck`
Expected: no errors.

---

### Task 3: RTL detection helper

**Files:**

- Create: `src/domains/languages/import/rtl.ts`
- Test: `src/domains/languages/import/rtl.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `isRTL(code: string, name: string): boolean` — consumed by Task 4 (`import-ethnologue.ts`).

- [ ] **Step 1: Write the failing tests**

Create `src/domains/languages/import/rtl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { isRTL } from './rtl';

describe('isRTL', () => {
  it('matches by explicit RTL code even when the name has no RTL keyword', () => {
    expect(isRTL('urd', 'Urdu')).toBe(true);
  });

  it('matches by RTL keyword in the name', () => {
    expect(isRTL('arb', 'Arabic, Baharna')).toBe(true);
    expect(isRTL('heb', 'Hebrew')).toBe(true);
  });

  it('matches Dhivehi via its explicit code rather than a name keyword', () => {
    expect(isRTL('div', 'Dhivehi')).toBe(true);
  });

  it('returns false for languages with no RTL signal', () => {
    expect(isRTL('eng', 'English')).toBe(false);
    expect(isRTL('fra', 'French')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- rtl.test.ts`
Expected: FAIL — `Cannot find module './rtl'`.

- [ ] **Step 3: Write the implementation**

Create `src/domains/languages/import/rtl.ts`:

```ts
/**
 * Script names matched against the Ethnologue English language name.
 * Catches language families like "Arabic, Baharna" or "Hebrew".
 * Source: issue #225 spec.
 */
const RTL_NAME_KEYWORDS = [
  'Arabic',
  'Hebrew',
  'Syriac',
  'Thaana',
  "N'Ko",
  'Adlam',
  'Hanifi Rohingya',
  'Mandaic',
  'Mende Kikakui',
  'Samaritan',
  'Yezidi',
  'Old Hungarian',
];

/**
 * Explicit ISO 639-3 codes for RTL languages whose English name doesn't
 * contain any of the keywords above (e.g. "Urdu" uses Arabic script but the
 * name doesn't contain "Arabic"). Best-effort — script direction is
 * definitively confirmed during DBL Bible ingestion (see issue #230).
 */
const RTL_CODES = new Set([
  'urd', // Urdu
  'fas',
  'pes',
  'prs', // Persian / Dari
  'pbt',
  'pbu',
  'pst', // Pashto variants
  'ckb',
  'sdh', // Kurdish (Sorani / Southern)
  'snd', // Sindhi
  'div', // Dhivehi (Maldivian)
  'uig', // Uyghur
  'kas', // Kashmiri
  'bal',
  'bcc',
  'bgn',
  'bgp', // Balochi variants
  'skr', // Saraiki
  'brh', // Brahui
  'haz', // Hazaragi
]);

export function isRTL(code: string, name: string): boolean {
  return RTL_CODES.has(code) || RTL_NAME_KEYWORDS.some((keyword) => name.includes(keyword));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- rtl.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and typecheck**

Run: `npm run lint:fix -- src/domains/languages/import/rtl.ts src/domains/languages/import/rtl.test.ts && npm run typecheck`
Expected: no errors.

---

### Task 4: Core Ethnologue import function

**Files:**

- Create: `src/domains/languages/import/import-ethnologue.ts`
- Test: `src/domains/languages/import/import-ethnologue.test.ts`

**Interfaces:**

- Consumes: `parseCsv` from `./csv` (Task 2), `isRTL` from `./rtl` (Task 3), `db` from `@/db`, `languages` from `@/db/schema` (Task 1's widened/unique columns).
- Produces:

  ```ts
  export interface ImportSummary {
    totalRows: number;
    inserted: number;
    skippedExisting: number;
    skippedInvalid: number;
    rtlCount: number;
    ltrCount: number;
  }
  export async function importEthnologueLanguages(csvContent: string): Promise<ImportSummary>;
  ```

  Consumed by Task 6 (CLI wrapper).

- [ ] **Step 1: Write the failing tests**

Create `src/domains/languages/import/import-ethnologue.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { languages } from '@/db/schema';

import { importEthnologueLanguages } from './import-ethnologue';

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = { insert: vi.fn() };
  const mockDb = { select: vi.fn(), transaction: vi.fn() };
  return { mockDb, mockTx };
});

vi.mock('@/db', () => ({ db: mockDb }));

function mockExistingCodes(codes: string[]) {
  mockDb.select.mockReturnValue({
    from: vi.fn().mockResolvedValue(codes.map((code) => ({ code }))),
  });
}

function mockInsertResult(rows: { id: number; scriptDirection: 'ltr' | 'rtl' }[]) {
  const valuesFn = vi.fn();
  mockTx.insert.mockReturnValue({ values: valuesFn });
  valuesFn.mockReturnValue({
    onConflictDoNothing: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  });
  return valuesFn;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockTx) => Promise<void>) => {
    await callback(mockTx);
  });
});

describe('importEthnologueLanguages', () => {
  it('throws when required columns are missing', async () => {
    await expect(importEthnologueLanguages('Foo,Bar\n1,2\n')).rejects.toThrow(/missing required/i);
  });

  it('throws instead of truncating a name over 255 characters', async () => {
    const longName = 'a'.repeat(256);
    await expect(importEthnologueLanguages(`LangID,Name\naaa,${longName}\n`)).rejects.toThrow(
      /exceeds 255 characters/
    );
  });

  it('skips rows with an invalid code length and still imports valid ones', async () => {
    mockExistingCodes([]);
    mockInsertResult([{ id: 1, scriptDirection: 'ltr' }]);

    const csv = 'LangID,Name\ntoolong,Bad Code\naaa,Valid Language\n';
    const summary = await importEthnologueLanguages(csv);

    expect(summary.totalRows).toBe(2);
    expect(summary.skippedInvalid).toBe(1);
    expect(summary.inserted).toBe(1);
  });

  it('skips codes that already exist in the database', async () => {
    mockExistingCodes(['aaa']);
    mockInsertResult([{ id: 2, scriptDirection: 'ltr' }]);

    const csv = 'LangID,Name\naaa,Existing Language\nbbb,New Language\n';
    const summary = await importEthnologueLanguages(csv);

    expect(summary.skippedExisting).toBe(1);
    expect(summary.inserted).toBe(1);
  });

  it('keeps the first occurrence when the same code appears twice in the file', async () => {
    mockExistingCodes([]);
    const valuesFn = mockInsertResult([{ id: 1, scriptDirection: 'ltr' }]);

    const csv = 'LangID,Name\naaa,First Name\naaa,Second Name\n';
    await importEthnologueLanguages(csv);

    expect(valuesFn).toHaveBeenCalledWith([
      expect.objectContaining({ langCodeIso6393: 'aaa', langName: 'First Name' }),
    ]);
  });

  it('marks a language as RTL by explicit code', async () => {
    mockExistingCodes([]);
    mockInsertResult([{ id: 1, scriptDirection: 'rtl' }]);

    const csv = 'LangID,Name\nurd,Urdu\n';
    const summary = await importEthnologueLanguages(csv);

    expect(summary.rtlCount).toBe(1);
    expect(summary.ltrCount).toBe(0);
  });

  it('counts inserted/rtl/ltr from what the database actually returns, not what was attempted', async () => {
    mockExistingCodes([]);
    // Simulate a race: only one of the two attempted rows actually inserted.
    mockInsertResult([{ id: 1, scriptDirection: 'ltr' }]);

    const csv = 'LangID,Name\naaa,Language A\nbbb,Language B\n';
    const summary = await importEthnologueLanguages(csv);

    expect(summary.inserted).toBe(1);
    expect(summary.ltrCount).toBe(1);
  });

  it('passes the unique code column as the onConflictDoNothing target', async () => {
    mockExistingCodes([]);
    const valuesFn = mockInsertResult([{ id: 1, scriptDirection: 'ltr' }]);

    await importEthnologueLanguages('LangID,Name\naaa,Language A\n');

    const onConflictMock = valuesFn.mock.results[0].value.onConflictDoNothing;
    expect(onConflictMock).toHaveBeenCalledWith({ target: languages.langCodeIso6393 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- import-ethnologue.test.ts`
Expected: FAIL — `Cannot find module './import-ethnologue'`.

- [ ] **Step 3: Write the implementation**

Create `src/domains/languages/import/import-ethnologue.ts`:

```ts
import { db } from '@/db';
import { languages } from '@/db/schema';

import { parseCsv } from './csv';
import { isRTL } from './rtl';

const MAX_FIELD_LENGTH = 255;
const CHUNK_SIZE = 1000;

export interface ImportSummary {
  totalRows: number;
  inserted: number;
  skippedExisting: number;
  skippedInvalid: number;
  rtlCount: number;
  ltrCount: number;
}

interface PendingLanguage {
  langCodeIso6393: string;
  langName: string;
  scriptDirection: 'ltr' | 'rtl';
}

export async function importEthnologueLanguages(csvContent: string): Promise<ImportSummary> {
  const { headers, rows } = parseCsv(csvContent);

  const codeIdx = headers.indexOf('langid');
  const nameIdx = headers.indexOf('name');

  if (codeIdx === -1 || nameIdx === -1) {
    throw new Error('CSV is missing required "LangID" and/or "Name" columns');
  }

  const byCode = new Map<string, PendingLanguage>();
  let skippedInvalid = 0;

  for (const row of rows) {
    const code = row[codeIdx]?.trim();
    const name = row[nameIdx]?.trim();

    if (!code || !name || code.length !== 3) {
      skippedInvalid++;
      continue;
    }

    if (name.length > MAX_FIELD_LENGTH) {
      throw new Error(
        `Language name exceeds ${MAX_FIELD_LENGTH} characters for code "${code}": "${name}"`
      );
    }

    if (byCode.has(code)) continue;

    byCode.set(code, {
      langCodeIso6393: code,
      langName: name,
      scriptDirection: isRTL(code, name) ? 'rtl' : 'ltr',
    });
  }

  const existing = await db.select({ code: languages.langCodeIso6393 }).from(languages);
  const existingCodes = new Set(existing.map((row) => row.code));

  const toInsert: PendingLanguage[] = [];
  let skippedExisting = 0;

  for (const language of byCode.values()) {
    if (existingCodes.has(language.langCodeIso6393)) {
      skippedExisting++;
      continue;
    }
    toInsert.push(language);
  }

  let inserted = 0;
  let rtlCount = 0;
  let ltrCount = 0;

  await db.transaction(async (tx) => {
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const insertedRows = await tx
        .insert(languages)
        .values(chunk)
        .onConflictDoNothing({ target: languages.langCodeIso6393 })
        .returning({ id: languages.id, scriptDirection: languages.scriptDirection });

      inserted += insertedRows.length;
      for (const row of insertedRows) {
        if (row.scriptDirection === 'rtl') rtlCount++;
        else ltrCount++;
      }
    }
  });

  return {
    totalRows: rows.length,
    inserted,
    skippedExisting,
    skippedInvalid,
    rtlCount,
    ltrCount,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- import-ethnologue.test.ts`
Expected: PASS (all 8 cases in Step 1).

- [ ] **Step 5: Lint and typecheck**

Run: `npm run lint:fix -- src/domains/languages/import/import-ethnologue.ts src/domains/languages/import/import-ethnologue.test.ts && npm run typecheck`
Expected: no errors. If `no-console` or `perfectionist/sort-imports` flags anything, let `lint:fix` reorder imports; do not hand-tune import order against the auto-fixer.

---

### Task 5: Localized-name enrichment function

**Files:**

- Create: `src/domains/languages/import/enrich-localized-names.ts`
- Test: `src/domains/languages/import/enrich-localized-names.test.ts`

**Interfaces:**

- Consumes: `parseCsv` from `./csv` (Task 2), `db`/`languages` (Task 1).
- Produces:

  ```ts
  export interface EnrichSummary {
    totalRows: number;
    enriched: number;
    skippedNoMatch: number;
    skippedAlreadySet: number;
  }
  export async function enrichLocalizedNames(csvContent: string): Promise<EnrichSummary>;
  ```

  Consumed by Task 7 (CLI wrapper).

- [ ] **Step 1: Write the failing tests**

Create `src/domains/languages/import/enrich-localized-names.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enrichLocalizedNames } from './enrich-localized-names';

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = { update: vi.fn() };
  const mockDb = { select: vi.fn(), transaction: vi.fn() };
  return { mockDb, mockTx };
});

vi.mock('@/db', () => ({ db: mockDb }));

function mockExistingLanguages(
  rows: { id: number; code: string | null; localized: string | null }[]
) {
  mockDb.select.mockReturnValue({ from: vi.fn().mockResolvedValue(rows) });
}

function mockUpdateChain() {
  const setFn = vi.fn();
  const whereFn = vi.fn().mockResolvedValue(undefined);
  setFn.mockReturnValue({ where: whereFn });
  mockTx.update.mockReturnValue({ set: setFn });
  return { setFn, whereFn };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockTx) => Promise<void>) => {
    await callback(mockTx);
  });
});

describe('enrichLocalizedNames', () => {
  it('throws when required columns are missing', async () => {
    mockExistingLanguages([]);
    await expect(enrichLocalizedNames('Foo,Bar\n1,2\n')).rejects.toThrow(/missing required/i);
  });

  it('throws instead of truncating a localized name over 255 characters', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    const longName = 'a'.repeat(256);
    await expect(enrichLocalizedNames(`ISO_639,Print_Name\naaa,${longName}\n`)).rejects.toThrow(
      /exceeds 255 characters/
    );
  });

  it('sets the localized name for a matching language with none set yet', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    const { setFn, whereFn } = mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\naaa,Autonym One\n');

    expect(summary.enriched).toBe(1);
    expect(setFn).toHaveBeenCalledWith({ langNameLocalized: 'Autonym One' });
    expect(whereFn).toHaveBeenCalled();
  });

  it('does not overwrite a language that already has a localized name', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: 'Existing Autonym' }]);
    mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\naaa,New Autonym\n');

    expect(summary.enriched).toBe(0);
    expect(summary.skippedAlreadySet).toBe(1);
    expect(mockTx.update).not.toHaveBeenCalled();
  });

  it('counts a code with no matching language row as skippedNoMatch', async () => {
    mockExistingLanguages([]);
    mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\nzzz,Unknown Language\n');

    expect(summary.skippedNoMatch).toBe(1);
    expect(mockTx.update).not.toHaveBeenCalled();
  });

  it('only enriches once when the same code appears twice in the file', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    const { setFn } = mockUpdateChain();

    const summary = await enrichLocalizedNames(
      'ISO_639,Print_Name\naaa,First Autonym\naaa,Second Autonym\n'
    );

    expect(summary.enriched).toBe(1);
    expect(setFn).toHaveBeenCalledTimes(1);
    expect(setFn).toHaveBeenCalledWith({ langNameLocalized: 'First Autonym' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- enrich-localized-names.test.ts`
Expected: FAIL — `Cannot find module './enrich-localized-names'`.

- [ ] **Step 3: Write the implementation**

Create `src/domains/languages/import/enrich-localized-names.ts`:

```ts
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { languages } from '@/db/schema';

import { parseCsv } from './csv';

const MAX_FIELD_LENGTH = 255;

export interface EnrichSummary {
  totalRows: number;
  enriched: number;
  skippedNoMatch: number;
  skippedAlreadySet: number;
}

interface ExistingLanguage {
  id: number;
  code: string | null;
  localized: string | null;
}

export async function enrichLocalizedNames(csvContent: string): Promise<EnrichSummary> {
  const { headers, rows } = parseCsv(csvContent);

  const codeIdx = headers.indexOf('iso_639');
  const nameIdx = headers.indexOf('print_name');

  if (codeIdx === -1 || nameIdx === -1) {
    throw new Error('CSV is missing required "ISO_639" and/or "Print_Name" columns');
  }

  const existing: ExistingLanguage[] = await db
    .select({
      id: languages.id,
      code: languages.langCodeIso6393,
      localized: languages.langNameLocalized,
    })
    .from(languages);

  const byCode = new Map(
    existing
      .filter((language) => language.code !== null)
      .map((language) => [language.code as string, language])
  );

  let skippedNoMatch = 0;
  let skippedAlreadySet = 0;
  let enriched = 0;

  await db.transaction(async (tx) => {
    for (const row of rows) {
      const code = row[codeIdx]?.trim();
      const printName = row[nameIdx]?.trim();

      if (!code || !printName) {
        skippedNoMatch++;
        continue;
      }

      if (printName.length > MAX_FIELD_LENGTH) {
        throw new Error(
          `Localized name exceeds ${MAX_FIELD_LENGTH} characters for code "${code}": "${printName}"`
        );
      }

      const match = byCode.get(code);

      if (!match) {
        skippedNoMatch++;
        continue;
      }

      if (match.localized) {
        skippedAlreadySet++;
        continue;
      }

      await tx
        .update(languages)
        .set({ langNameLocalized: printName })
        .where(eq(languages.id, match.id));

      match.localized = printName;
      enriched++;
    }
  });

  return {
    totalRows: rows.length,
    enriched,
    skippedNoMatch,
    skippedAlreadySet,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- enrich-localized-names.test.ts`
Expected: PASS (all 6 cases in Step 1).

- [ ] **Step 5: Lint and typecheck**

Run: `npm run lint:fix -- src/domains/languages/import/enrich-localized-names.ts src/domains/languages/import/enrich-localized-names.test.ts && npm run typecheck`
Expected: no errors.

---

### Task 6: CLI wrapper for the core import

**Files:**

- Create: `src/db/scripts/import-ethnologue-languages.ts`
- Modify: `package.json` (`scripts` section)

**Interfaces:**

- Consumes: `importEthnologueLanguages` from `@/domains/languages/import/import-ethnologue` (Task 4).
- Produces: `npm run db:import:languages -- <path>` CLI entry point. Nothing downstream depends on this file's internals.

- [ ] **Step 1: Write the script**

Create `src/db/scripts/import-ethnologue-languages.ts`:

```ts
import { readFileSync } from 'node:fs';

import { importEthnologueLanguages } from '@/domains/languages/import/import-ethnologue';

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: npm run db:import:languages -- <path-to-ethnologue-csv>');
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`Failed to read file: ${filePath}`, error);
    process.exit(1);
  }

  const summary = await importEthnologueLanguages(content);

  console.log('Ethnologue import complete:');
  console.log(`  Total rows:        ${summary.totalRows}`);
  console.log(`  Inserted:          ${summary.inserted}`);
  console.log(`  Skipped (in DB):   ${summary.skippedExisting}`);
  console.log(`  Skipped (invalid): ${summary.skippedInvalid}`);
  console.log(`  RTL:               ${summary.rtlCount}`);
  console.log(`  LTR:               ${summary.ltrCount}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Import failed:', error);
    process.exit(1);
  });
```

- [ ] **Step 2: Add the npm script**

In `package.json`, in the `scripts` section, add a line after `"db:setup": "npx tsx src/db/scripts/setup.ts",`:

```json
    "db:import:languages": "npx tsx src/db/scripts/import-ethnologue-languages.ts",
```

- [ ] **Step 3: Manual smoke test**

Create a throwaway sample file (not committed) and run the script against it:

```bash
printf 'LangID\tCountryID\tLangStatus\tName\naaa\tUS\tL\tSample Language One\nurd\tPK\tL\tUrdu\n' > /tmp/sample-ethnologue.tsv
npm run db:import:languages -- /tmp/sample-ethnologue.tsv
```

Expected: requires a reachable `DATABASE_URL` (local dev Postgres). Output should show `Total rows: 2`, `Inserted: 2` (or fewer if those codes already exist locally), and `RTL: 1` (for `urd`), `LTR: 1`. Delete `/tmp/sample-ethnologue.tsv` afterward — it's scratch, not a repo artifact.

If no local Postgres is reachable, skip actually running it and instead confirm via `npm run typecheck` that the script compiles cleanly — note in your task summary that the live run wasn't performed and why.

- [ ] **Step 4: Lint and typecheck**

Run: `npm run lint:fix -- src/db/scripts/import-ethnologue-languages.ts && npm run typecheck`
Expected: no errors (note `no-console` is disabled for `src/db/scripts/**`, so `console.log`/`console.error` here are fine).

---

### Task 7: CLI wrapper for enrichment

**Files:**

- Create: `src/db/scripts/enrich-language-names.ts`
- Modify: `package.json` (`scripts` section)

**Interfaces:**

- Consumes: `enrichLocalizedNames` from `@/domains/languages/import/enrich-localized-names` (Task 5).
- Produces: `npm run db:import:language-names -- <path>` CLI entry point.

- [ ] **Step 1: Write the script**

Create `src/db/scripts/enrich-language-names.ts`:

```ts
import { readFileSync } from 'node:fs';

import { enrichLocalizedNames } from '@/domains/languages/import/enrich-localized-names';

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: npm run db:import:language-names -- <path-to-autonyms-csv>');
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`Failed to read file: ${filePath}`, error);
    process.exit(1);
  }

  const summary = await enrichLocalizedNames(content);

  console.log('Localized-name enrichment complete:');
  console.log(`  Total rows:          ${summary.totalRows}`);
  console.log(`  Enriched:            ${summary.enriched}`);
  console.log(`  Skipped (no match):  ${summary.skippedNoMatch}`);
  console.log(`  Skipped (already set): ${summary.skippedAlreadySet}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Enrichment failed:', error);
    process.exit(1);
  });
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add a line right after the `db:import:languages` line added in Task 6:

```json
    "db:import:language-names": "npx tsx src/db/scripts/enrich-language-names.ts",
```

- [ ] **Step 3: Manual smoke test**

```bash
printf 'ISO_639\tPrint_Name\naaa\tSample Autonym\n' > /tmp/sample-autonyms.tsv
npm run db:import:language-names -- /tmp/sample-autonyms.tsv
```

Expected: if `aaa` was inserted by Task 6's smoke test and has no localized name yet, output shows `Enriched: 1`. Same caveat as Task 6 Step 3 if no local Postgres is reachable. Delete `/tmp/sample-autonyms.tsv` afterward.

- [ ] **Step 4: Lint and typecheck**

Run: `npm run lint:fix -- src/db/scripts/enrich-language-names.ts && npm run typecheck`
Expected: no errors.

---

### Task 8: Full verification pass

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: all tests pass, including the new ones from Tasks 2, 3, 4, 5 and all pre-existing tests (confirming nothing in `src/db/seeds/languages.ts` or elsewhere broke).

- [ ] **Step 2: Run the full lint pass**

Run: `npm run lint`
Expected: no errors across the whole repo, including `package.json` formatting (`npm run format:check`).

- [ ] **Step 3: Run the full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Confirm the untouched seed path**

Run: `git diff --stat -- src/db/seeds/`
Expected: empty output — no changes under `src/db/seeds/` at all, confirming `db:setup` / `db:seed:languages` are unaffected.

- [ ] **Step 5: Do not commit**

Confirm final state with `git status --short`. Leave everything uncommitted for the user to review — do not run `git add` or `git commit` for any file touched in this plan.
