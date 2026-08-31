CREATE TYPE "public"."tts_license_status" AS ENUM('allowed', 'forbidden', 'unknown');--> statement-breakpoint
ALTER TABLE "bibles" ADD COLUMN "aquifer_bible_id" integer;--> statement-breakpoint
ALTER TABLE "bibles" ADD COLUMN "tts_license_status" "tts_license_status" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "bibles" ADD COLUMN "license_notice" text;