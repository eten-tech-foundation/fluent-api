ALTER TABLE "ai"."ai_suggestion_jobs"
  ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "error_message" text;
--> statement-breakpoint
ALTER TABLE "ai"."ai_suggestions"
  ALTER COLUMN "suggested_text" TYPE text;
--> statement-breakpoint
DROP INDEX IF EXISTS "ai"."uq_ai_jobs_range";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_jobs_range" ON "ai"."ai_suggestion_jobs" USING btree (
  "project_unit_id",
  "bible_id",
  "book_code",
  "chapter_number",
  "verse_start",
  "verse_end"
);
