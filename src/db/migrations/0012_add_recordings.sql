CREATE TABLE "recordings" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_unit_id" integer NOT NULL,
	"bible_text_id" integer NOT NULL,
	"relative_path" varchar NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_relative_path_unique" UNIQUE("relative_path")
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_project_unit_id_project_units_id_fk" FOREIGN KEY ("project_unit_id") REFERENCES "public"."project_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_bible_text_id_bible_texts_id_fk" FOREIGN KEY ("bible_text_id") REFERENCES "public"."bible_texts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_recordings_project_unit" ON "recordings" USING btree ("project_unit_id");--> statement-breakpoint
CREATE INDEX "idx_recordings_bible_text" ON "recordings" USING btree ("bible_text_id");--> statement-breakpoint
CREATE INDEX "idx_recordings_user" ON "recordings" USING btree ("recorded_by_user_id");