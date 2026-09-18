CREATE TYPE "public"."milestone_type" AS ENUM('text', 'audio');--> statement-breakpoint
ALTER TABLE "project_units" ADD COLUMN "name" varchar(255);--> statement-breakpoint
ALTER TABLE "project_units" ADD COLUMN "type" "milestone_type" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_units" ADD COLUMN "connectivity_profile" varchar(255);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_bible_id" integer;--> statement-breakpoint
UPDATE "project_units" AS pu
SET "name" = COALESCE(p."name", 'Milestone ' || pu."id")
FROM "projects" AS p
WHERE pu."project_id" = p."id";--> statement-breakpoint
UPDATE "project_units" AS pu
SET "connectivity_profile" = NULLIF(p."metadata"->>'connectivityProfile', '')
FROM "projects" AS p
WHERE pu."project_id" = p."id";--> statement-breakpoint
UPDATE "projects" AS p
SET "source_bible_id" = sub."bible_id"
FROM (
  SELECT DISTINCT ON (pu."project_id") pu."project_id", pubb."bible_id"
  FROM "project_units" AS pu
  INNER JOIN "project_unit_bible_books" AS pubb ON pubb."project_unit_id" = pu."id"
  ORDER BY pu."project_id", pu."id"
) AS sub
WHERE p."id" = sub."project_id";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "projects" WHERE "source_bible_id" IS NULL) THEN
    RAISE EXCEPTION 'projects.source_bible_id backfill incomplete: projects without book rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "project_units" WHERE "name" IS NULL) THEN
    RAISE EXCEPTION 'project_units.name backfill incomplete';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "project_units" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "source_bible_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_bible_id_bibles_id_fk" FOREIGN KEY ("source_bible_id") REFERENCES "public"."bibles"("id") ON DELETE no action ON UPDATE no action;
