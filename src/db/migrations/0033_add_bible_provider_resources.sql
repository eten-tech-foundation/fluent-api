CREATE TYPE "public"."resource_provider" AS ENUM('dbl', 'aquifer', 'youversion');--> statement-breakpoint
CREATE TYPE "public"."tts_license_status" AS ENUM('allowed', 'forbidden', 'unknown');--> statement-breakpoint
CREATE TABLE "bible_provider_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" "resource_provider" NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"tts_license_status" "tts_license_status" DEFAULT 'unknown' NOT NULL,
	"license_notice" text,
	"display_name" text
);
--> statement-breakpoint
ALTER TABLE "bibles" ADD COLUMN "audio_resource_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bible_provider_resources_identity" ON "bible_provider_resources" USING btree ("provider","external_id");--> statement-breakpoint
ALTER TABLE "bibles" ADD CONSTRAINT "bibles_audio_resource_id_bible_provider_resources_id_fk" FOREIGN KEY ("audio_resource_id") REFERENCES "public"."bible_provider_resources"("id") ON DELETE restrict ON UPDATE no action;