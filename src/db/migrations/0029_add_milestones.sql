CREATE TYPE "public"."milestone_type" AS ENUM('text', 'audio');--> statement-breakpoint
ALTER TABLE "project_unit_bible_books" ADD CONSTRAINT "project_unit_bible_books_project_unit_id_book_id_pk" PRIMARY KEY("project_unit_id","book_id");--> statement-breakpoint
ALTER TABLE "project_unit_bible_books" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "project_units" ADD COLUMN "name" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "project_units" ADD COLUMN "type" "milestone_type" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_units" ADD COLUMN "connectivity_profile" varchar(255);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_bible_id" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_bible_id_bibles_id_fk" FOREIGN KEY ("source_bible_id") REFERENCES "public"."bibles"("id") ON DELETE no action ON UPDATE no action;