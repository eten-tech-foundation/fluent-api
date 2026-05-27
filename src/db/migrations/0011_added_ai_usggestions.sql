CREATE TABLE "ai"."ai_suggestion_usage_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bible_text_id" integer NOT NULL,
	"project_unit_id" integer NOT NULL,
	"was_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapter_assignments" ADD COLUMN "is_ai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai"."ai_suggestion_usage_log" ADD CONSTRAINT "ai_suggestion_usage_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."ai_suggestion_usage_log" ADD CONSTRAINT "ai_suggestion_usage_log_bible_text_id_bible_texts_id_fk" FOREIGN KEY ("bible_text_id") REFERENCES "public"."bible_texts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."ai_suggestion_usage_log" ADD CONSTRAINT "ai_suggestion_usage_log_project_unit_id_project_units_id_fk" FOREIGN KEY ("project_unit_id") REFERENCES "public"."project_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_usage_user" ON "ai"."ai_suggestion_usage_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_project_unit" ON "ai"."ai_suggestion_usage_log" USING btree ("project_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_usage_user_text" ON "ai"."ai_suggestion_usage_log" USING btree ("user_id","bible_text_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai"."ai_suggestion_usage_log" TO role_web_data;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "ai"."ai_suggestion_usage_log_id_seq" TO role_web_data;