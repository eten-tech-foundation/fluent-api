DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chapter_assignments" AS ca
    WHERE NOT EXISTS (
      SELECT 1
      FROM "public"."project_unit_bible_books" AS link
      WHERE link."project_unit_id" = ca."project_unit_id"
        AND link."book_id" = ca."book_id"
        AND link."bible_id" = ca."bible_id"
    )
  ) THEN
    RAISE EXCEPTION 'Cannot add fk_chapter_assignments_bible_book_link: chapter_assignments contains rows without a matching project_unit_bible_books (project_unit_id, book_id, bible_id) tuple.'
      USING HINT = 'Reconcile these rows before rerunning migration 0040_chapter_assignment_bible_fk.';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "project_unit_bible_books" ADD CONSTRAINT "uq_project_unit_bible_books_unit_book_bible" UNIQUE("project_unit_id","book_id","bible_id");--> statement-breakpoint
ALTER TABLE "chapter_assignments" ADD CONSTRAINT "fk_chapter_assignments_bible_book_link" FOREIGN KEY ("project_unit_id","book_id","bible_id") REFERENCES "public"."project_unit_bible_books"("project_unit_id","book_id","bible_id") ON DELETE cascade ON UPDATE cascade;
