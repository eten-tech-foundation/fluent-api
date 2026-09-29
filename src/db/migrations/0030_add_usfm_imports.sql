CREATE TABLE "project_unit_usfm_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_unit_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"usfm" text NOT NULL,
	"materialized_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_unit_usfm_imports" ADD CONSTRAINT "project_unit_usfm_imports_project_unit_id_project_units_id_fk" FOREIGN KEY ("project_unit_id") REFERENCES "public"."project_units"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "project_unit_usfm_imports" ADD CONSTRAINT "project_unit_usfm_imports_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usfm_import_per_unit_book" ON "project_unit_usfm_imports" USING btree ("project_unit_id","book_id");