-- When provider-resource license/display facts are inserted or changed by any
-- SQL path, advance linked bible watermarks so incremental GET /bibles?updatedAfter=
-- observes them. Text identity: DBL provider + external_id. Recording selection:
-- audio_resource_id (selectedRecordingKey changes advance via bibles.$onUpdate).
--
-- Migration chain note: numbered 0037 after main claimed 0034 (conflict resolved)
-- and 0035 (dynamic workflow stages). Companion books timestamps live in 0036.
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
    SET updated_at = now()
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_bump_bibles_on_provider_resource_license ON bible_provider_resources;--> statement-breakpoint
CREATE TRIGGER trg_bump_bibles_on_provider_resource_license
AFTER INSERT OR UPDATE OF tts_license_status, license_notice, display_name, provider, external_id
ON bible_provider_resources
FOR EACH ROW
EXECUTE FUNCTION bump_linked_bibles_on_provider_resource_license();
