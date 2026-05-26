CREATE SCHEMA IF NOT EXISTS "ai";
--> statement-breakpoint
CREATE TABLE "ai"."ai_suggestion_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_unit_id" integer NOT NULL,
	"bible_id" integer NOT NULL,
	"book_code" varchar(50) NOT NULL,
	"chapter_number" integer NOT NULL,
	"verse_start" integer NOT NULL,
	"verse_end" integer NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ai"."ai_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"bible_text_id" integer NOT NULL,
	"project_unit_id" integer NOT NULL,
	"suggested_text" varchar NOT NULL,
	"model_info" varchar(100),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "ai"."ai_suggestion_jobs" ADD CONSTRAINT "ai_suggestion_jobs_project_unit_id_project_units_id_fk" FOREIGN KEY ("project_unit_id") REFERENCES "public"."project_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."ai_suggestion_jobs" ADD CONSTRAINT "ai_suggestion_jobs_bible_id_bibles_id_fk" FOREIGN KEY ("bible_id") REFERENCES "public"."bibles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."ai_suggestions" ADD CONSTRAINT "ai_suggestions_bible_text_id_bible_texts_id_fk" FOREIGN KEY ("bible_text_id") REFERENCES "public"."bible_texts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."ai_suggestions" ADD CONSTRAINT "ai_suggestions_project_unit_id_project_units_id_fk" FOREIGN KEY ("project_unit_id") REFERENCES "public"."project_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_jobs_project_unit" ON "ai"."ai_suggestion_jobs" USING btree ("project_unit_id");--> statement-breakpoint
CREATE INDEX "idx_ai_jobs_status" ON "ai"."ai_suggestion_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_jobs_range" ON "ai"."ai_suggestion_jobs" USING btree ("project_unit_id","book_code","chapter_number","verse_start","verse_end");--> statement-breakpoint
CREATE INDEX "idx_ai_suggestions_bible_text" ON "ai"."ai_suggestions" USING btree ("bible_text_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_suggestions_per_text_unit" ON "ai"."ai_suggestions" USING btree ("bible_text_id","project_unit_id");