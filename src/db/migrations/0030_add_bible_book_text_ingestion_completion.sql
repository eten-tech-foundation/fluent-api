ALTER TABLE "bible_books" ADD COLUMN "text_ingested_at" timestamp;--> statement-breakpoint
UPDATE "bible_books"
SET "text_ingested_at" = now()
WHERE "text_ingested_at" IS NULL
	AND EXISTS (
		SELECT 1 FROM "bible_texts"
		WHERE "bible_texts"."bible_id" = "bible_books"."bible_id"
			AND "bible_texts"."book_id" = "bible_books"."book_id"
	);
