ALTER TABLE "languages" ALTER COLUMN "lang_name" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "languages" ALTER COLUMN "lang_name_localized" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "languages" ADD CONSTRAINT "languages_lang_code_iso_639_3_unique" UNIQUE("lang_code_iso_639_3");