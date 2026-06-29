# AI Suggestions Workflow — Complete Architecture Guide

This document describes how AI-powered translation suggestions are generated, delivered, and consumed across the **fluent-api** (TypeScript/Hono) and **fluent-ai** (Python/FastAPI) services.

---

## Table of Contents

- [Before vs After — What Changed](#before-vs-after--what-changed)
- [High-Level Architecture](#high-level-architecture)
- [Phase 1 — Triggering](#phase-1--triggering-frontend--api)
- [Phase 2 — Handoff to AI Service](#phase-2--handoff-to-ai-service-api--ai)
- [Phase 3 — Context Retrieval](#phase-3--context-retrieval-ai--api)
- [Phase 4 — LLM Translation](#phase-4--llm-translation-ai--google-gemini)
- [Phase 5 — Result Delivery](#phase-5--result-delivery-ai--api)
- [Phase 6 — Serving to Frontend](#phase-6--serving-to-frontend-api--frontend)
- [Key Design Decisions](#key-design-decisions)
- [Environment Variables](#environment-variables)

---

## Before vs After — What Changed

### The Old Flow (Shared Database)

```mermaid
UI → API → writes jobs into ai.ai_suggestion_jobs (cross-schema INSERT)
                                    │
                                    ▼
              AI polls ai.ai_suggestion_jobs (its own schema)
              AI reads public.bible_texts, public.books,
                    public.projects, public.languages,
                    public.project_units, public.translated_verses
                    (cross-schema SELECT via read-only role)
              AI calls Google Gemini
              AI writes results into ai.ai_suggestions (its own schema)
                                    │
                                    ▼
              API reads ai.ai_suggestions (cross-schema SELECT)
              API serves results to UI
```

**Problem:** Both services were reaching into each other's database schemas. The API wrote to `ai.*` tables, and the AI read from `public.*` tables. Despite being separate codebases, they were tightly coupled at the persistence layer.

### The New Flow (HTTP-Only)

```mermaid
Step 1 ─ UI calls API
         Triggered by: User assigns a chapter OR drafter reaches a new verse
         API creates a pg-boss job in its own local queue
                    │
                    │  Triggered by: pg-boss polling (automatic, every 2s)
                    ▼
Step 2 ─ API background worker picks up the job
         Worker sends HTTP POST /suggestions to AI service
                    │
                    │  Triggered by: the HTTP request arriving
                    ▼
Step 3 ─ AI receives the request, saves job to its own ai.jobs table
         Returns HTTP 200 immediately
                    │
                    │  Triggered by: AI worker polling ai.jobs (automatic, every 5s)
                    ▼
Step 4 ─ AI background worker picks up the job
         Worker needs context data, so it calls back to API:
         HTTP POST /internal/suggestion-context
                    │
                    │  Triggered by: the HTTP request arriving
                    ▼
Step 5 ─ API receives the context request
         API queries its OWN tables (bible_texts, translated_verses, etc.)
         API runs FTS + proximity search
         API returns JSON: { contextVerses, sourceVerses, targetLanguageName }
                    │
                    │  Triggered by: AI receiving the HTTP response
                    ▼
Step 6 ─ AI builds the prompt from the context data
         AI calls Google Gemini with translation memory + source verses
         Gemini returns translated text
                    │
                    │  Triggered by: AI receiving the Gemini response
                    ▼
Step 7 ─ AI pushes results directly to API:
         HTTP POST /internal/ai-suggestions
         Note: AI does NOT store suggestions in its own database.
         AI only marks its local job as "completed".
                    │
                    │  Triggered by: the HTTP request arriving
                    ▼
Step 8 ─ API receives the suggestions
         API upserts them into its OWN ai_suggestions table
         (This is the ONLY place suggestions are stored)
                    │
                    │  Triggered by: UI polling / user navigating to a verse
                    ▼
Step 9 ─ UI calls GET /ai-suggestions?bibleTextIds=...
         API reads from its own ai_suggestions table
         API returns suggestions to the UI
```

> **Important:** There is no "copy" step for suggestions. The AI service acts as a translation engine — it receives a request, fetches context over HTTP, calls Gemini, and pushes the result back over HTTP. The only table the AI owns is `ai.jobs` (its internal work queue). All suggestion data lives exclusively in the API.

### Who Reads What — Data Ownership Table

| Data                                          | Who Owns It                                   | Who Reads It       | How                                                |
| --------------------------------------------- | --------------------------------------------- | ------------------ | -------------------------------------------------- |
| `bible_texts`, `books`, `languages`           | **API** (public schema)                       | **API only**       | Direct SQL queries                                 |
| `projects`, `project_units`                   | **API** (public schema)                       | **API only**       | Direct SQL queries                                 |
| `translated_verses`                           | **API** (public schema)                       | **API only**       | Direct SQL queries                                 |
| `ai_suggestions`                              | **API** (public schema, moved from ai schema) | **API only**       | Direct SQL queries                                 |
| `ai_suggestion_usage_log`                     | **API** (public schema, moved from ai schema) | **API only**       | Direct SQL queries                                 |
| `jobs` (formerly `ai_suggestion_jobs`)        | **AI** (ai schema)                            | **AI only**        | Direct SQL queries                                 |
| `api_keys`                                    | **AI** (ai schema)                            | **AI only**        | Direct SQL queries                                 |
| Translation context (FTS + proximity results) | Computed by **API**                           | Consumed by **AI** | **HTTP** — `POST /internal/suggestion-context`     |
| Source verses to translate                    | Owned by **API**                              | Consumed by **AI** | **HTTP** — returned in suggestion-context response |
| Generated suggestions                         | Produced by **AI**                            | Stored by **API**  | **HTTP** — `POST /internal/ai-suggestions`         |
| Trigger "please translate these verses"       | Produced by **API**                           | Consumed by **AI** | **HTTP** — `POST /suggestions`                     |

### Key Difference

> **Before:** The AI service had a read-only database role (`role_ai_reader`) that gave it `SELECT` access to 6 tables in the API's `public` schema. The API had cross-schema write access to the AI's `ai.ai_suggestion_jobs` table. Both services needed to understand each other's table structures.
>
> **After:** Neither service touches the other's database. All data exchange happens over 3 HTTP endpoints. Each service can change its schema freely without breaking the other.

---

## High-Level Architecture

```mermaid
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                │
│  Drafter types translations → triggers queue-next / reads       │
│  suggestions via GET /ai-suggestions                            │
└────────────┬──────────────────────────────────────┬─────────────┘
             │ POST /ai-suggestions/queue-next      │ GET /ai-suggestions
             ▼                                      ▲
┌─────────────────────────────────────────────────────────────────┐
│                       FLUENT-API (TypeScript)                   │
│                                                                 │
│  ┌──────────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ ai-suggestions   │───▶│  pg-boss     │───▶│ ai-trigger    │  │
│  │ .service.ts      │    │  queue       │    │ .worker.ts    │──┼──▶ POST /suggestions (AI)
│  └──────────────────┘    └──────────────┘    └───────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ /internal/suggestion-context   (FTS + proximity search)  │◀──┼── AI calls back
│  │ /internal/ai-suggestions       (upsert results)          │◀──┼── AI calls back
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ▲  ▲
                              │  │  HTTP (Bearer token auth)
                              │  │
┌─────────────────────────────┼──┼────────────────────────────────┐
│                       FLUENT-AI (Python)                        │
│                              │  │                               │
│  ┌───────────────┐    ┌──────┘  └──────┐    ┌───────────────┐   │
│  │ POST          │───▶│ suggestion     │───▶│ Translation   │   │
│  │ /suggestions  │    │ _processor.py  │    │ Service       │───┼──▶ Google Gemini
│  └───────────────┘    │ (worker loop)  │    └───────────────┘   │
│                       └────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Triggering (Frontend → API)

### What triggers AI suggestions?

There are **two trigger points**, both in `fluent-api`:

#### Trigger A: Chapter Assignment (Bulk Initial Queue)

When a chapter is assigned to a drafter, the API automatically queues AI suggestions for the first N verses.

**File:** `ai-suggestions.service.ts` → `handleChapterAssigned()`

```text
Chapter assigned
  → Look up book code from bookId
  → Check if the activation threshold is met
       (i.e., enough human translations exist in this language pair
        to serve as meaningful context for the LLM)
  → If threshold is met:
       Find the first N untranslated verses (AI_INITIAL_QUEUE_COUNT)
       → Enqueue them as a pg-boss job
```

#### Trigger B: Drafter Working (Rolling Lookahead)

As the drafter progresses through verses, the frontend calls `POST /ai-suggestions/queue-next` to pre-generate suggestions ahead of the cursor.

**File:** `ai-suggestions.service.ts` → `queueNextVerses()`

```text
Drafter reaches verse X
  → Frontend calls POST /ai-suggestions/queue-next
  → API checks:
       1. Has the activation threshold been met?
       2. Is AI enabled on this chapter assignment? (isAiEnabled flag)
  → If both true:
       Find the next N untranslated verses after currentVerse
       (AI_DEFAULT_LOOKAHEAD)
       → Enqueue them as a pg-boss job
```

### The Activation Threshold

AI suggestions don't start from scratch. The system first checks whether there are enough existing human translations for the same source→target language pair within the same organization. This threshold (`AI_ACTIVATION_THRESHOLD_VERSES`) ensures the LLM has meaningful translation memory to learn style and vocabulary from before generating its own suggestions.

**File:** `ai-suggestions.repository.ts` → `hasReachedAiActivationThreshold()`

```sql
-- Conceptually:
SELECT 1 FROM translated_verses
  JOIN project_units ON ...
  JOIN projects ON ...
WHERE projects.source_language = :source
  AND projects.target_language = :target
  AND projects.organization = :org
  AND length(trim(translated_verses.content)) > 0
LIMIT 1 OFFSET (threshold - 1)
```

If this returns a row, there are at least `threshold` non-empty translations available as context.

### What gets enqueued?

Each pg-boss job payload is an array of individual verse requests:

```json
{
  "projectUnitId": 42,
  "bibleId": 1,
  "bookCode": "MAT",
  "chapterNumber": 5,
  "verseStart": 3,
  "verseEnd": 3
}
```

**File:** `lib/queue.ts` — Queue name: `AI_SUGGESTION_TRIGGER`

---

## Phase 2 — Handoff to AI Service (API → AI)

### The pg-boss Worker

A background worker running in `standalone-worker.ts` continuously polls the pg-boss queue.

**File:** `workers/ai-trigger.worker.ts`

```text
pg-boss picks up a job
  → Worker calls triggerAiSuggestions(jobs)
  → This fires an HTTP POST to fluent-ai:
       POST {AI_SERVICE_BASE_URL}/suggestions
       Headers: X-API-Key: {AI_SERVICE_API_KEY}
       Body: [ { projectUnitId, bibleId, bookCode, ... }, ... ]
```

**File:** `lib/ai-client.ts` — The HTTP client

### AI Service Receives the Trigger

On the AI side, the `POST /suggestions` endpoint receives the batch and inserts each item into the local `ai.jobs` table.

**File (AI):** `routers/suggestions.py`

```python
# For each request item, build a dedup key and insert:
dedup_key = f"ai_suggestion:{projectUnitId}:{bibleId}:{bookCode}:{chapter}:{verseStart}:{verseEnd}"

INSERT INTO ai.jobs (task_type, payload, dedup_key, status)
VALUES ('ai_suggestion', <JSONB payload>, <dedup_key>, 'queued')
ON CONFLICT (dedup_key) DO NOTHING  -- idempotent
```

The dedup key prevents duplicate processing if the API retries (pg-boss guarantees at-least-once delivery).

---

## Phase 3 — Context Retrieval (AI → API)

### The AI Worker Loop

The AI service runs a background asyncio task that polls `ai.jobs` for queued work.

**File (AI):** `worker/suggestion_processor.py` → `worker_loop()`

```python
# Claim one job at a time using row-level locking:
SELECT * FROM ai.jobs
WHERE status = 'queued'
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED

# Mark it as 'processing' and begin work
```

### Fetching Context via HTTP

Instead of querying the API's database directly, the worker calls back to fluent-api:

```python
POST {API_BASE_URL}/internal/suggestion-context
Headers: Authorization: Bearer {API_SERVICE_KEY}
Body: {
    "projectUnitId": 42,
    "bibleId": 1,
    "bookCode": "MAT",
    "chapterNumber": 5,
    "verseStart": 3,
    "verseEnd": 3
}
```

**File (API):** `domains/ai-internal/ai-internal.route.ts` — Protected by `requireServiceAuth` middleware

### What the API Does for Context

The repository function `getSuggestionContextData()` performs a sophisticated multi-step query:

**File (API):** `domains/ai-internal/ai-internal.repository.ts`

#### Step 1: Resolve Project Languages

```text
Look up the project's source and target language IDs
and the organization from project_units → projects.
```

#### Step 2: Resolve FTS Configuration

```text
Map the source language code (e.g. "eng") to a PostgreSQL
full-text search dictionary (e.g. "english").
Languages without specific Postgres FTS support (e.g. Hindi,
Gujarati) fall back to "simple" (whitespace tokenization).
```

#### Step 3: Get the Target Verse Text

```text
Fetch the source text of the specific verse being translated.
This text becomes the FTS search query.
```

#### Step 4A: Full-Text Search (FTS)

```sql
-- Find existing translations that are textually similar to the verse being translated
SELECT bible_texts.*, translated_verses.content
FROM translated_verses
  JOIN bible_texts ON ...
  JOIN books ON ...
  JOIN project_units ON ...
  JOIN projects ON ...
WHERE projects.target_language = :target
  AND projects.source_language = :source
  AND projects.organization = :org
  AND translated_verses.content IS NOT NULL
  AND to_tsvector(:fts_config, bible_texts.text) @@ plainto_tsquery(:fts_config, :target_text)
ORDER BY ts_rank(...) DESC
LIMIT 50
```

This finds verses with similar vocabulary to serve as relevant translation memory.

#### Step 4B: Proximity Search (Backfill)

```sql
-- Fill remaining slots with nearby verses (same chapter first, then nearby chapters)
SELECT ... FROM translated_verses
WHERE bible_text_id NOT IN (:fts_results)  -- exclude duplicates
ORDER BY
  CASE WHEN project_unit_id = :current THEN 0 ELSE 1 END,  -- same project unit first
  ABS(chapter_number - :target_chapter) ASC,                -- closest chapters
  ABS(verse_number - :target_verse) ASC                     -- closest verses
LIMIT (100 - fts_count)
```

#### Step 5: Fetch Source Verses

```sql
-- Get the actual verse texts that need translation
SELECT id, verse_number, text FROM bible_texts
WHERE bible_id = :bibleId
  AND book_code = :bookCode
  AND chapter_number = :chapter
  AND verse_number BETWEEN :verseStart AND :verseEnd
```

### Response Shape

The endpoint returns a single JSON object:

```json
{
  "targetLanguageName": "Hindi",
  "contextVerses": [
    {
      "verse_id": "mat_5_1",
      "source_text": "And seeing the multitudes...",
      "target_text": "भीड़ को देखकर..."
    }
  ],
  "sourceVerses": [
    {
      "id": 12345,
      "verse_number": 3,
      "text": "Blessed are the poor in spirit..."
    }
  ]
}
```

---

## Phase 4 — LLM Translation (AI → Google Gemini)

### Building the Prompt

The worker assembles a structured prompt for Google Gemini using the context and source verses it received.

**File (AI):** `services/translation_service.py`

#### System Instruction

```text
You are an expert Bible translator, fluent in biblical languages,
English, and {target_language_name}. Your goal is to translate
biblical text with absolute theological accuracy, natural
grammatical flow, and culturally appropriate honorifics.

CRITICAL INSTRUCTIONS:
1. Study the <translation_memory> provided.
2. Mimic the linguistic style, vocabulary, spelling, and
   honorific rules from the memory.
3. If a theological term appears in the source, look for how
   it was translated in the memory. Do not invent new terms.
4. Pay strict attention to gender, plurality, and respect markers.
```

#### User Prompt

```xml
<translation_memory>
[Verse ID: mat_5_1]
Source: And seeing the multitudes, he went up into a mountain...
Target: भीड़ को देखकर वह पहाड़ पर चढ़ गया...

[Verse ID: mat_5_2]
Source: And he opened his mouth, and taught them, saying,
Target: और उसने अपना मुँह खोला और उन्हें सिखाया...
</translation_memory>

Based strictly on the established vocabulary, grammar, and style
in the <translation_memory> above, translate the following new
verses into Hindi.

<verses_to_translate>
[Verse ID: mat_5_3]
Source: Blessed are the poor in spirit: for theirs is the kingdom of heaven.
</verses_to_translate>

Respond ONLY with a valid JSON object matching this schema:
{
  "translations": [
    { "verse_id": "...", "target_text": "..." }
  ]
}
```

#### LLM Response

```json
{
  "translations": [
    {
      "verse_id": "mat_5_3",
      "target_text": "धन्य हैं वे जो मन के दीन हैं, क्योंकि स्वर्ग का राज्य उन्हीं का है।"
    }
  ]
}
```

---

## Phase 5 — Result Delivery (AI → API)

After receiving the LLM response, the worker maps each translation back to its source verse and pushes the results to the API:

**File (AI):** `worker/suggestion_processor.py` → `process_job()`

```python
POST {API_BASE_URL}/internal/ai-suggestions
Headers: Authorization: Bearer {API_SERVICE_KEY}
Body: {
    "items": [
        {
            "bibleTextId": 12345,
            "projectUnitId": 42,
            "suggestedText": "धन्य हैं वे जो मन के दीन हैं...",
            "modelInfo": "gemini-2.5-flash-lite"
        }
    ]
}
```

### API Stores the Results

**File (API):** `domains/ai-internal/ai-internal.repository.ts` → `upsertAiSuggestions()`

```sql
INSERT INTO ai_suggestions (bible_text_id, project_unit_id, suggested_text, model_info)
VALUES (:bibleTextId, :projectUnitId, :suggestedText, :modelInfo)
ON CONFLICT (bible_text_id, project_unit_id)
DO UPDATE SET
  suggested_text = EXCLUDED.suggested_text,
  model_info = EXCLUDED.model_info
```

The `ON CONFLICT` upsert ensures idempotency — re-processing a job safely overwrites instead of duplicating.

The worker then marks the local job as `completed` in `ai.jobs`.

---

## Phase 6 — Serving to Frontend (API → Frontend)

When the drafter's editor needs suggestions, the frontend calls:

```http
GET /ai-suggestions?projectUnitId=42&bibleTextIds=12345,12346,12347
```

**File (API):** `ai-suggestions.route.ts` + `ai-suggestions.service.ts`

### Authorization Flow

1. `authenticateUser` — Validates the user's session
2. `requirePermission(PERMISSIONS.PROJECT_VIEW)` — Checks RBAC
3. `requireProjectUnitAccess` — Verifies the user is a member of the project that owns this project unit (prevents cross-tenant access)

### Query

```sql
SELECT * FROM ai_suggestions
WHERE project_unit_id = :projectUnitId
  AND bible_text_id IN (:ids)
```

### Response

```json
{
  "data": [
    {
      "bibleTextId": 12345,
      "suggestedText": "धन्य हैं वे जो मन के दीन हैं...",
      "modelInfo": "gemini-2.5-flash-lite"
    }
  ]
}
```

### Usage Tracking

When a drafter views or accepts a suggestion, the frontend calls:

```http
POST /ai-suggestions/usage
Body: { "bibleTextId": 12345, "projectUnitId": 42, "wasUsed": true }
```

This is stored in `ai_suggestion_usage_log` for analytics.

---

## Key Design Decisions

| Decision                    | Rationale                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **HTTP-only communication** | No shared database between services. Either can change its schema independently.                                                                                                     |
| **pg-boss queue**           | At-least-once delivery with retry semantics. If the API crashes after committing a chapter assignment but before queueing, the worst case is a missed trigger (not data corruption). |
| **Idempotent endpoints**    | Dedup keys on the AI side and `ON CONFLICT DO UPDATE` on the API side ensure safe retries.                                                                                           |
| **FTS lives in the API**    | The context retrieval logic (full-text search + proximity) runs against the API's own database. The AI service never touches `bible_texts` or `translated_verses`.                   |
| **Two separate auth keys**  | `AI_SERVICE_API_KEY` (API→AI) and `AI_INBOUND_SERVICE_KEY` (AI→API) allow independent rotation and scoped blast radius.                                                              |
| **Activation threshold**    | AI won't generate suggestions until enough human translations exist for the language pair. This prevents low-quality outputs when there's no translation memory.                     |
| **Verse-level granularity** | Each verse is its own job item. This allows fine-grained retry (one verse failing doesn't block others) and deduplication.                                                           |

---

## Environment Variables

### fluent-api

| Variable                          | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `AI_SERVICE_BASE_URL`             | URL of the fluent-ai service (e.g. `http://fluent-ai:8200`)        |
| `AI_SERVICE_API_KEY`              | Sent as `X-API-Key` header when triggering AI                      |
| `AI_INBOUND_SERVICE_KEY`          | Expected in `Authorization: Bearer` from AI on `/internal/*` calls |
| `AI_ACTIVATION_THRESHOLD_VERSES`  | Min translated verses needed before AI kicks in                    |
| `AI_DEFAULT_LOOKAHEAD`            | How many verses ahead to pre-generate during drafting              |
| `AI_INITIAL_QUEUE_COUNT`          | How many verses to queue when a chapter is first assigned          |
| `AI_MAX_REQUESTED_BIBLE_TEXT_IDS` | Max verse IDs per GET request (rate limit)                         |

### fluent-ai

| Variable            | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `API_BASE_URL`      | URL of the fluent-api service (e.g. `http://fluent-api:9999`) |
| `API_SERVICE_KEY`   | Must match `AI_INBOUND_SERVICE_KEY` above                     |
| `GOOGLE_AI_API_KEY` | API key for Google Gemini                                     |
| `GOOGLE_AI_MODEL`   | Model name (e.g. `gemini-2.5-flash-lite`)                     |
