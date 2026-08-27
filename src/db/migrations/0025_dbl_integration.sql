CREATE TYPE "public"."bible_provider" AS ENUM('dbl');--> statement-breakpoint
DROP INDEX "idx_bible_texts_bible_book_chapter_verse";--> statement-breakpoint
ALTER TABLE "bibles" ADD COLUMN "provider" "bible_provider" DEFAULT 'dbl' NOT NULL;--> statement-breakpoint
ALTER TABLE "bibles" ADD COLUMN "external_id" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bible_books_bible_book" ON "bible_books" USING btree ("bible_id","book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bibles_provider_external_id" ON "bibles" USING btree ("provider","external_id") WHERE "bibles"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bible_texts_bible_book_chapter_verse" ON "bible_texts" USING btree ("bible_id","book_id","chapter_number","verse_number");--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_code_unique" UNIQUE("code");