ALTER TABLE "project_unit_bible_books" ADD COLUMN "running_header" varchar;--> statement-breakpoint
ALTER TABLE "project_unit_bible_books" ADD COLUMN "book_title" varchar;--> statement-breakpoint
ALTER TABLE "translated_verses" ADD COLUMN "markers" jsonb;