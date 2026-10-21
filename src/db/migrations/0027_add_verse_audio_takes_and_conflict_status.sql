CREATE TYPE "public"."verse_audio_conflict_status" AS ENUM('clean', 'conflict');--> statement-breakpoint
CREATE TABLE "verse_audio_takes" (
	"id" serial PRIMARY KEY NOT NULL,
	"recording_id" integer NOT NULL,
	"uploaded_by" integer NOT NULL,
	"storage_object_id" integer,
	"content_type" varchar NOT NULL,
	"size_bytes" integer NOT NULL,
	"duration_seconds" real,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD COLUMN "version_token" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD COLUMN "conflict_status" "verse_audio_conflict_status" DEFAULT 'clean' NOT NULL;--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD COLUMN "active_take_id" integer;--> statement-breakpoint
ALTER TABLE "verse_audio_takes" ADD CONSTRAINT "verse_audio_takes_recording_id_verse_audio_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."verse_audio_recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verse_audio_takes" ADD CONSTRAINT "verse_audio_takes_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verse_audio_takes" ADD CONSTRAINT "verse_audio_takes_storage_object_id_storage_objects_id_fk" FOREIGN KEY ("storage_object_id") REFERENCES "public"."storage_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_verse_audio_takes_recording" ON "verse_audio_takes" USING btree ("recording_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_verse_audio_take_content_hash" ON "verse_audio_takes" USING btree ("recording_id","content_hash");--> statement-breakpoint
-- Backfill one take per existing recording so active_take_id can be set.
-- Legacy hashes are unique placeholders (bytes are not re-hashed at migrate time).
INSERT INTO "verse_audio_takes" (
	"recording_id",
	"uploaded_by",
	"storage_object_id",
	"content_type",
	"size_bytes",
	"duration_seconds",
	"content_hash",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"uploaded_by",
	"storage_object_id",
	"content_type",
	"size_bytes",
	"duration_seconds",
	'legacy-' || "id"::text,
	"created_at",
	"updated_at"
FROM "verse_audio_recordings";--> statement-breakpoint
UPDATE "verse_audio_recordings" AS r
SET "active_take_id" = t."id"
FROM "verse_audio_takes" AS t
WHERE t."recording_id" = r."id";--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD CONSTRAINT "verse_audio_recordings_active_take_id_verse_audio_takes_id_fk" FOREIGN KEY ("active_take_id") REFERENCES "public"."verse_audio_takes"("id") ON DELETE set null ON UPDATE no action;