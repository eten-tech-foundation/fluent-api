-- When provider-resource license/display facts are inserted or changed by any
-- SQL path, advance linked bible watermarks so incremental GET /bibles?updatedAfter=
-- observes them. Text identity: DBL provider + external_id. Recording selection:
-- audio_resource_id (selectedRecordingKey changes advance via bibles.$onUpdate).
--
-- Migration chain note: this PR claims 0035 (+ meta/0035_snapshot.json journal
-- entry). Sibling #391 currently reserves 0037 for verse-audio range metadata —
-- before land, rebase if main has claimed 0035/0036 and keep the snapshot/journal
-- chain contiguous with whatever landed first.
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
