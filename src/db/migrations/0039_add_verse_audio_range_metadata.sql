CREATE TYPE "public"."verse_audio_granularity" AS ENUM('verse', 'pericope');--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD COLUMN "granularity" "verse_audio_granularity" DEFAULT 'verse' NOT NULL;--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD COLUMN "start_chapter" integer;--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD COLUMN "start_verse" integer;--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD COLUMN "end_chapter" integer;--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD COLUMN "end_verse" integer;--> statement-breakpoint
ALTER TABLE "verse_audio_takes" ADD COLUMN "granularity" "verse_audio_granularity" DEFAULT 'verse' NOT NULL;--> statement-breakpoint
ALTER TABLE "verse_audio_takes" ADD COLUMN "start_chapter" integer;--> statement-breakpoint
ALTER TABLE "verse_audio_takes" ADD COLUMN "start_verse" integer;--> statement-breakpoint
ALTER TABLE "verse_audio_takes" ADD COLUMN "end_chapter" integer;--> statement-breakpoint
ALTER TABLE "verse_audio_takes" ADD COLUMN "end_verse" integer;--> statement-breakpoint
CREATE INDEX "idx_verse_audio_recordings_project_unit" ON "verse_audio_recordings" USING btree ("project_unit_id");