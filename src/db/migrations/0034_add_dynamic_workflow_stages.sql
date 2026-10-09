CREATE TABLE "project_workflow_stages" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"default_name" varchar(50) NOT NULL,
	"display_name" varchar(30) NOT NULL,
	"position" integer NOT NULL,
	"is_fixed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chapter_assignment_assigned_user_history" ALTER COLUMN "status" SET DATA TYPE varchar(50) USING "status"::text;--> statement-breakpoint
ALTER TABLE "chapter_assignment_snapshots" ALTER COLUMN "status" SET DATA TYPE varchar(50) USING "status"::text;--> statement-breakpoint
ALTER TABLE "chapter_assignment_status_history" ALTER COLUMN "status" SET DATA TYPE varchar(50) USING "status"::text;--> statement-breakpoint
ALTER TABLE "chapter_assignments" ALTER COLUMN "chapter_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chapter_assignments" ALTER COLUMN "chapter_status" SET DATA TYPE varchar(50) USING "chapter_status"::text;--> statement-breakpoint
ALTER TABLE "chapter_assignments" ALTER COLUMN "chapter_status" SET DEFAULT 'not_started';--> statement-breakpoint
ALTER TABLE "project_workflow_stages" ADD CONSTRAINT "project_workflow_stages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_default_name" ON "project_workflow_stages" USING btree ("project_id","default_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_position" ON "project_workflow_stages" USING btree ("project_id","position");--> statement-breakpoint
DROP TYPE "public"."chapter_status";--> statement-breakpoint
INSERT INTO "project_workflow_stages" ("project_id", "default_name", "display_name", "position", "is_fixed")
SELECT
    p.id as project_id,
    stages.default_name,
    stages.display_name,
    stages.position,
    stages.is_fixed
FROM "projects" p
CROSS JOIN (
    VALUES
        ('not_started', 'Not Started', 0, true),
        ('draft', 'Drafting', 1, true),
        ('peer_check', 'Peer Check', 2, true),
        ('community_review', 'Community Review', 3, false),
        ('linguist_check', 'Linguist Check', 4, false),
        ('theological_check', 'Theological Check', 5, false),
        ('consultant_check', 'Consultant Check', 6, false),
        ('complete', 'Complete', 7, true)
) AS stages(default_name, display_name, position, is_fixed)
ON CONFLICT ("project_id", "default_name") DO NOTHING;
