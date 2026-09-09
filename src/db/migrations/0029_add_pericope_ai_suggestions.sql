CREATE TABLE "ai_pericope_suggestion_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"suggestion_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"was_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_pericope_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_unit_id" integer NOT NULL,
	"bible_text_id" integer NOT NULL,
	"pericope_set_id" integer NOT NULL,
	"pericope_number" varchar(100) NOT NULL,
	"suggested_text" varchar(300) NOT NULL,
	"model_info" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_pericope_suggestion_usage" ADD CONSTRAINT "ai_pericope_suggestion_usage_suggestion_id_ai_pericope_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."ai_pericope_suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pericope_suggestion_usage" ADD CONSTRAINT "ai_pericope_suggestion_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pericope_suggestions" ADD CONSTRAINT "ai_pericope_suggestions_project_unit_id_project_units_id_fk" FOREIGN KEY ("project_unit_id") REFERENCES "public"."project_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pericope_suggestions" ADD CONSTRAINT "ai_pericope_suggestions_bible_text_id_bible_texts_id_fk" FOREIGN KEY ("bible_text_id") REFERENCES "public"."bible_texts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pericope_suggestions" ADD CONSTRAINT "ai_pericope_suggestions_pericope_set_id_pericope_sets_id_fk" FOREIGN KEY ("pericope_set_id") REFERENCES "public"."pericope_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_pericope_usage_user" ON "ai_pericope_suggestion_usage" USING btree ("suggestion_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_pericope_suggestion" ON "ai_pericope_suggestions" USING btree ("project_unit_id","bible_text_id","pericope_set_id","pericope_number");