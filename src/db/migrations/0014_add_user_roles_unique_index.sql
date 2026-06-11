DROP INDEX "uq_user_role_grant";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_role_grant" ON "user_roles" USING btree ("user_id",COALESCE("org_id", -1),COALESCE("project_id", -1),"role_id");