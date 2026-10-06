-- No backfill: existing bible_texts rows prove some verses landed, not that the book is
-- complete, and there is no expected chapter or verse count to check them against. Marking a
-- partially ingested book complete would let an import treat its missing chapters as
-- versification gaps and drop the translated content. Completion is set only by the code that
-- has ingested a whole book, and project creation re-queues any book still left null.
ALTER TABLE "bible_books" ADD COLUMN "text_ingested_at" timestamp;
