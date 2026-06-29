CREATE TABLE "pericope_sets" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"description" varchar(500),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "pericope_sets_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "pericope_verses" (
	"id" serial PRIMARY KEY NOT NULL,
	"pericope_set_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"chapter_number" integer NOT NULL,
	"verse_number" integer NOT NULL,
	"section" integer,
	"pericope_number" varchar(20) NOT NULL,
	"pericope_title" varchar(500)
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pericope_set_id" integer;--> statement-breakpoint
ALTER TABLE "pericope_verses" ADD CONSTRAINT "pericope_verses_pericope_set_id_pericope_sets_id_fk" FOREIGN KEY ("pericope_set_id") REFERENCES "public"."pericope_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pericope_verses" ADD CONSTRAINT "pericope_verses_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pericope_verses_set_book_chapter_verse" ON "pericope_verses" USING btree ("pericope_set_id","book_id","chapter_number","verse_number");--> statement-breakpoint
CREATE INDEX "idx_pericope_verses_set_book_pericope" ON "pericope_verses" USING btree ("pericope_set_id","book_id","pericope_number","chapter_number","verse_number");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_pericope_set_id_pericope_sets_id_fk" FOREIGN KEY ("pericope_set_id") REFERENCES "public"."pericope_sets"("id") ON DELETE no action ON UPDATE no action;
