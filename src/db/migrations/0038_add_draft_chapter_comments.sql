-- =============================================================================
-- Migration: draft chapter comments (#458 / mobile #451 #703)
-- Tag: 0038_add_draft_chapter_comments (journal idx 38; snapshot 0038_snapshot.json)
--
-- BRANCH LANDING / REBASE COORDINATION:
--   - origin/main journal ends at 0037; this branch registers the next sequential
--     idx (38) with tag 0038_add_draft_chapter_comments.
--   - Open PRs also propose distinct 0038_* tags (notably #391
--     0038_add_verse_audio_range_metadata @ d1baee7; also #445, #446). This
--     branch does NOT import those implementations. On rebase/merge, whichever
--     0038 lands second must renumber its idx/tag/snapshot — document the
--     conflict in the PR; do not require the other PR to merge first.
--   - Never run this migrate against QA/dev/prod from agent sessions.
-- =============================================================================

CREATE TYPE "public"."comment_anchor_kind" AS ENUM('verse', 'pericope');--> statement-breakpoint
CREATE TYPE "public"."comment_body_kind" AS ENUM('text', 'audio', 'emoji');--> statement-breakpoint
CREATE TYPE "public"."comment_connection_state" AS ENUM('connected', 'unconnected');--> statement-breakpoint
CREATE TABLE "chapter_comment_reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"comment_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" varchar(32) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapter_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"chapter_assignment_id" integer NOT NULL,
	"author_user_id" integer NOT NULL,
	"parent_comment_id" integer,
	"body_kind" "comment_body_kind" NOT NULL,
	"body_text" text,
	"emoji" varchar(32),
	"audio_storage_key" varchar(512),
	"audio_content_type" varchar(128),
	"audio_byte_size" integer,
	"audio_duration_seconds" real,
	"audio_content_hash" varchar(64),
	"anchor_kind" "comment_anchor_kind" NOT NULL,
	"anchor_bible_id" integer NOT NULL,
	"anchor_book_id" integer NOT NULL,
	"anchor_chapter_number" integer NOT NULL,
	"anchor_bible_text_id" integer,
	"anchor_verse_number" integer,
	"anchor_pericope_set_id" integer,
	"anchor_pericope_number" varchar(20),
	"anchor_pericope_title" varchar(500),
	"connection_state" "comment_connection_state" DEFAULT 'connected' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chapter_comments_body_exclusive" CHECK (
		(
			"body_kind" = 'text'
			AND "body_text" IS NOT NULL
			AND btrim("body_text") <> ''
			AND "emoji" IS NULL
			AND "audio_storage_key" IS NULL
		)
		OR (
			"body_kind" = 'emoji'
			AND "emoji" IS NOT NULL
			AND btrim("emoji") <> ''
			AND "body_text" IS NULL
			AND "audio_storage_key" IS NULL
		)
		OR (
			"body_kind" = 'audio'
			AND "audio_storage_key" IS NOT NULL
			AND "body_text" IS NULL
			AND "emoji" IS NULL
		)
	),
	CONSTRAINT "chapter_comments_anchor_shape" CHECK (
		(
			"anchor_kind" = 'verse'
			AND "anchor_bible_text_id" IS NOT NULL
			AND "anchor_verse_number" IS NOT NULL
		)
		OR (
			"anchor_kind" = 'pericope'
			AND "anchor_pericope_set_id" IS NOT NULL
			AND "anchor_pericope_number" IS NOT NULL
			AND btrim("anchor_pericope_number") <> ''
		)
	)
);
--> statement-breakpoint
ALTER TABLE "chapter_comment_reactions" ADD CONSTRAINT "chapter_comment_reactions_comment_id_chapter_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."chapter_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_comment_reactions" ADD CONSTRAINT "chapter_comment_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_comments" ADD CONSTRAINT "chapter_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_comments" ADD CONSTRAINT "chapter_comments_chapter_assignment_id_chapter_assignments_id_fk" FOREIGN KEY ("chapter_assignment_id") REFERENCES "public"."chapter_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_comments" ADD CONSTRAINT "chapter_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_comments" ADD CONSTRAINT "chapter_comments_parent_comment_id_chapter_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."chapter_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_comments" ADD CONSTRAINT "chapter_comments_anchor_bible_id_bibles_id_fk" FOREIGN KEY ("anchor_bible_id") REFERENCES "public"."bibles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_comments" ADD CONSTRAINT "chapter_comments_anchor_book_id_books_id_fk" FOREIGN KEY ("anchor_book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Intentionally NO FK on anchor_bible_text_id / anchor_pericope_set_id (immutable snapshots).
CREATE INDEX "idx_chapter_comment_reactions_comment" ON "chapter_comment_reactions" USING btree ("comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chapter_comment_reaction_user" ON "chapter_comment_reactions" USING btree ("comment_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_chapter_comments_assignment_created" ON "chapter_comments" USING btree ("chapter_assignment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_chapter_comments_project_connection" ON "chapter_comments" USING btree ("project_id","connection_state");--> statement-breakpoint
CREATE INDEX "idx_chapter_comments_parent" ON "chapter_comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "idx_chapter_comments_author_assignment" ON "chapter_comments" USING btree ("chapter_assignment_id","author_user_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION mark_chapter_comments_unconnected_for_pericope_set_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.pericope_set_id IS DISTINCT FROM OLD.pericope_set_id
  THEN
    UPDATE chapter_comments
    SET
      connection_state = 'unconnected',
      updated_at = now()
    WHERE project_id = NEW.id
      AND connection_state = 'connected'
      AND anchor_kind = 'pericope'
      AND (
        anchor_pericope_set_id IS DISTINCT FROM NEW.pericope_set_id
        OR anchor_pericope_set_id IS NULL
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_chapter_comments_unconnected_on_project_pericope_set ON projects;--> statement-breakpoint
CREATE TRIGGER trg_chapter_comments_unconnected_on_project_pericope_set
AFTER UPDATE OF pericope_set_id ON projects
FOR EACH ROW
EXECUTE FUNCTION mark_chapter_comments_unconnected_for_pericope_set_change();--> statement-breakpoint
CREATE OR REPLACE FUNCTION mark_chapter_comments_unconnected_for_pericope_verse_mutation()
RETURNS trigger AS $$
DECLARE
  tgt_set_id integer;
  tgt_book_id integer;
  tgt_chapter integer;
  tgt_pericope_number varchar(20);
BEGIN
  IF TG_OP = 'DELETE' THEN
    tgt_set_id := OLD.pericope_set_id;
    tgt_book_id := OLD.book_id;
    tgt_chapter := OLD.chapter_number;
    tgt_pericope_number := OLD.pericope_number;
  ELSE
    tgt_set_id := NEW.pericope_set_id;
    tgt_book_id := NEW.book_id;
    tgt_chapter := NEW.chapter_number;
    tgt_pericope_number := NEW.pericope_number;
  END IF;

  UPDATE chapter_comments
  SET
    connection_state = 'unconnected',
    updated_at = now()
  WHERE connection_state = 'connected'
    AND anchor_kind = 'pericope'
    AND anchor_pericope_set_id = tgt_set_id
    AND anchor_book_id = tgt_book_id
    AND anchor_chapter_number = tgt_chapter
    AND anchor_pericope_number = tgt_pericope_number;

  IF TG_OP = 'UPDATE'
    AND (
      OLD.pericope_set_id IS DISTINCT FROM NEW.pericope_set_id
      OR OLD.book_id IS DISTINCT FROM NEW.book_id
      OR OLD.chapter_number IS DISTINCT FROM NEW.chapter_number
      OR OLD.pericope_number IS DISTINCT FROM NEW.pericope_number
    )
  THEN
    UPDATE chapter_comments
    SET
      connection_state = 'unconnected',
      updated_at = now()
    WHERE connection_state = 'connected'
      AND anchor_kind = 'pericope'
      AND anchor_pericope_set_id = OLD.pericope_set_id
      AND anchor_book_id = OLD.book_id
      AND anchor_chapter_number = OLD.chapter_number
      AND anchor_pericope_number = OLD.pericope_number;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_chapter_comments_unconnected_on_pericope_verses ON pericope_verses;--> statement-breakpoint
CREATE TRIGGER trg_chapter_comments_unconnected_on_pericope_verses
AFTER INSERT OR UPDATE OR DELETE ON pericope_verses
FOR EACH ROW
EXECUTE FUNCTION mark_chapter_comments_unconnected_for_pericope_verse_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION mark_chapter_comments_unconnected_for_bible_text_delete()
RETURNS trigger AS $$
BEGIN
  UPDATE chapter_comments
  SET
    connection_state = 'unconnected',
    updated_at = now()
  WHERE connection_state = 'connected'
    AND anchor_kind = 'verse'
    AND anchor_bible_text_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_chapter_comments_unconnected_on_bible_text_delete ON bible_texts;--> statement-breakpoint
CREATE TRIGGER trg_chapter_comments_unconnected_on_bible_text_delete
AFTER DELETE ON bible_texts
FOR EACH ROW
EXECUTE FUNCTION mark_chapter_comments_unconnected_for_bible_text_delete();--> statement-breakpoint
CREATE OR REPLACE FUNCTION mark_chapter_comments_unconnected_for_pericope_set_delete()
RETURNS trigger AS $$
BEGIN
  UPDATE chapter_comments
  SET
    connection_state = 'unconnected',
    updated_at = now()
  WHERE connection_state = 'connected'
    AND anchor_kind = 'pericope'
    AND anchor_pericope_set_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_chapter_comments_unconnected_on_pericope_set_delete ON pericope_sets;--> statement-breakpoint
CREATE TRIGGER trg_chapter_comments_unconnected_on_pericope_set_delete
AFTER DELETE ON pericope_sets
FOR EACH ROW
EXECUTE FUNCTION mark_chapter_comments_unconnected_for_pericope_set_delete();--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_chapter_comment_reaction(
  p_comment_id integer,
  p_user_id integer,
  p_emoji varchar
) RETURNS varchar AS $$
DECLARE
  cur varchar;
BEGIN
  PERFORM pg_advisory_xact_lock(p_comment_id, p_user_id);

  SELECT emoji INTO cur
  FROM chapter_comment_reactions
  WHERE comment_id = p_comment_id AND user_id = p_user_id;

  IF cur IS NULL THEN
    INSERT INTO chapter_comment_reactions (comment_id, user_id, emoji)
    VALUES (p_comment_id, p_user_id, p_emoji);
    RETURN p_emoji;
  ELSIF cur = p_emoji THEN
    DELETE FROM chapter_comment_reactions
    WHERE comment_id = p_comment_id AND user_id = p_user_id;
    RETURN NULL;
  ELSE
    UPDATE chapter_comment_reactions
    SET emoji = p_emoji, updated_at = now()
    WHERE comment_id = p_comment_id AND user_id = p_user_id;
    RETURN p_emoji;
  END IF;
END;
$$ LANGUAGE plpgsql;
