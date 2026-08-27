CREATE TABLE "verse_audio_recordings" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_unit_id" integer NOT NULL,
	"bible_text_id" integer NOT NULL,
	"uploaded_by" integer NOT NULL,
	"content_type" varchar NOT NULL,
	"size_bytes" integer NOT NULL,
	"duration_seconds" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD CONSTRAINT "verse_audio_recordings_project_unit_id_project_units_id_fk" FOREIGN KEY ("project_unit_id") REFERENCES "public"."project_units"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD CONSTRAINT "verse_audio_recordings_bible_text_id_bible_texts_id_fk" FOREIGN KEY ("bible_text_id") REFERENCES "public"."bible_texts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verse_audio_recordings" ADD CONSTRAINT "verse_audio_recordings_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_verse_audio_per_bible_text" ON "verse_audio_recordings" USING btree ("project_unit_id","bible_text_id");