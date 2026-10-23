-- Commit-ordered catalogue revision allocator (#404).
-- A timestamp-shaped logical revision preserves the existing updatedAfter API.
-- Updating this singleton takes a row lock held until commit/rollback: no other
-- catalogue writer can publish a newer revision while this transaction is in flight.
-- Millisecond steps survive the API's JavaScript Date serialization. Wall-clock
-- regressions cannot move the revision backwards. Do not replace with a sequence
-- or clock_timestamp() alone: neither orders concurrent transaction commits.
CREATE TABLE "catalogue_watermark" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "catalogue_watermark_singleton" CHECK ("catalogue_watermark"."id" = true)
);--> statement-breakpoint
INSERT INTO "catalogue_watermark" ("id", "updated_at")
SELECT true, greatest(
  clock_timestamp() AT TIME ZONE 'UTC',
  (SELECT max(updated_at) FROM languages),
  (SELECT max(updated_at) FROM bibles),
  (SELECT max(updated_at) FROM books)
);--> statement-breakpoint
CREATE FUNCTION next_catalogue_watermark()
RETURNS timestamp AS $$
DECLARE
  revision timestamp;
BEGIN
  UPDATE public.catalogue_watermark
  SET updated_at = greatest(
    date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
    updated_at + interval '1 millisecond'
  )
  WHERE id = true
  RETURNING updated_at INTO STRICT revision;
  RETURN revision;
END;
$$ LANGUAGE plpgsql VOLATILE;--> statement-breakpoint
-- Defaults are evaluated at insertion, including transactions begun before a
-- cursor was issued. All catalogue inserts and updates must use the allocator;
-- explicit client timestamps are not valid catalogue write watermarks.
ALTER TABLE "bibles" ALTER COLUMN "updated_at" SET DEFAULT next_catalogue_watermark();--> statement-breakpoint
ALTER TABLE "books" ALTER COLUMN "updated_at" SET DEFAULT next_catalogue_watermark();--> statement-breakpoint
ALTER TABLE "languages" ALTER COLUMN "updated_at" SET DEFAULT next_catalogue_watermark();--> statement-breakpoint
-- Provider-resource license trigger must advance linked bibles via the allocator
-- (replacing now() from 0037) so concurrent commits cannot skip rows.
CREATE OR REPLACE FUNCTION bump_linked_bibles_on_provider_resource_license()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT'
    OR NEW.tts_license_status IS DISTINCT FROM OLD.tts_license_status
    OR NEW.license_notice IS DISTINCT FROM OLD.license_notice
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.external_id IS DISTINCT FROM OLD.external_id
  THEN
    UPDATE bibles
    SET updated_at = next_catalogue_watermark()
    WHERE audio_resource_id = NEW.id
      OR (
        NEW.provider = 'dbl'
        AND bibles.provider = 'dbl'
        AND bibles.external_id = NEW.external_id
      )
      OR (
        TG_OP = 'UPDATE'
        AND OLD.provider = 'dbl'
        AND bibles.provider = 'dbl'
        AND bibles.external_id = OLD.external_id
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
