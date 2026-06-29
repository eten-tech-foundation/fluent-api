CREATE TABLE "ai_suggestion_usage_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bible_text_id" integer NOT NULL,
	"project_unit_id" integer NOT NULL,
	"was_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"bible_text_id" integer NOT NULL,
	"project_unit_id" integer NOT NULL,
	"suggested_text" text NOT NULL,
	"model_info" varchar(100),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chapter_assignments" ADD COLUMN "is_ai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_suggestion_usage_log" ADD CONSTRAINT "ai_suggestion_usage_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestion_usage_log" ADD CONSTRAINT "ai_suggestion_usage_log_bible_text_id_bible_texts_id_fk" FOREIGN KEY ("bible_text_id") REFERENCES "public"."bible_texts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestion_usage_log" ADD CONSTRAINT "ai_suggestion_usage_log_project_unit_id_project_units_id_fk" FOREIGN KEY ("project_unit_id") REFERENCES "public"."project_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_bible_text_id_bible_texts_id_fk" FOREIGN KEY ("bible_text_id") REFERENCES "public"."bible_texts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_project_unit_id_project_units_id_fk" FOREIGN KEY ("project_unit_id") REFERENCES "public"."project_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_usage_user" ON "ai_suggestion_usage_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_project_unit" ON "ai_suggestion_usage_log" USING btree ("project_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_usage_user_text" ON "ai_suggestion_usage_log" USING btree ("user_id","bible_text_id");--> statement-breakpoint
CREATE INDEX "idx_ai_suggestions_bible_text" ON "ai_suggestions" USING btree ("bible_text_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_suggestions_per_text_unit" ON "ai_suggestions" USING btree ("bible_text_id","project_unit_id");