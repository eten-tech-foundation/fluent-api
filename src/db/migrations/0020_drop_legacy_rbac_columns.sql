ALTER TABLE "project_users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "roles" SET "name" = 'Project Manager' WHERE "name" = 'Manager';--> statement-breakpoint
UPDATE "roles" SET "name" = 'Project Translator' WHERE "name" = 'Translator';--> statement-breakpoint
INSERT INTO "roles" ("name") VALUES
  ('SuperAdmin'),
  ('Org Manager'),
  ('Org Member'),
  ('Project Manager'),
  ('Project Translator'),
  ('Project Observer')
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
INSERT INTO "user_roles" ("user_id", "org_id", "project_id", "role_id", "created_by")
SELECT u."id", NULL, NULL, r."id", u."id"
FROM "users" u
JOIN "roles" r ON r."name" = 'SuperAdmin'
WHERE u."role" = r."id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "user_roles" ("user_id", "org_id", "project_id", "role_id", "created_by")
SELECT u."id", u."organization", NULL, r."id", u."id"
FROM "users" u
JOIN "roles" r ON r."name" = 'Org Member'
WHERE u."organization" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "user_roles" ("user_id", "org_id", "project_id", "role_id", "created_by")
SELECT 
  pu."user_id", 
  p."organization", 
  pu."project_id", 
  u."role", 
  pu."user_id"
FROM "project_users" pu
JOIN "users" u ON u."id" = pu."user_id"
JOIN "projects" p ON p."id" = pu."project_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_roles_id_fk";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_organization_organizations_id_fk";--> statement-breakpoint
DROP TABLE "project_users" CASCADE;--> statement-breakpoint
DROP INDEX "idx_role_permissions_role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "organization";