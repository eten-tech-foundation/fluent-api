ALTER TABLE "bible_books" ADD COLUMN "has_audio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bibles" ADD COLUMN "has_audio" boolean DEFAULT false NOT NULL;