ALTER TABLE "project_users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "project_users" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_organization_organizations_id_fk";
--> statement-breakpoint
DROP INDEX "idx_role_permissions_role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "organization";