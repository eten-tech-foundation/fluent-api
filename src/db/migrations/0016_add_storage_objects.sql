CREATE TABLE "storage_objects" (
	"id" serial PRIMARY KEY NOT NULL,
	"bucket" varchar NOT NULL,
	"key" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD COLUMN "storage_object_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_storage_object_bucket_key" ON "storage_objects" USING btree ("bucket","key");--> statement-breakpoint
CREATE INDEX "idx_storage_objects_unreclaimed" ON "storage_objects" USING btree ("deleted_at");--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD CONSTRAINT "verse_audio_recordings_storage_object_id_storage_objects_id_fk" FOREIGN KEY ("storage_object_id") REFERENCES "public"."storage_objects"("id") ON DELETE no action ON UPDATE no action;