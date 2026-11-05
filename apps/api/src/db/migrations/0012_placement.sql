-- 0012 Placing a drawing on the earth (ADR-032, ADR-035).
--
-- `placement` (PlacementSchema in @ftth/shared) says how drawing coordinates become project CRS
-- metres: source CRS (project | Egypt Red Belt), control points (drawing x/y ↔ Lat/Lon) and a hand
-- adjustment. NULL = as drawn, already in the project CRS (every mapping and revision before this).
-- The mapping holds the editable copy; a revision freezes its own copy at creation like the rules.

ALTER TABLE cad_mappings ADD COLUMN placement jsonb
  CHECK (placement IS NULL OR jsonb_typeof(placement) = 'object');
ALTER TABLE design_revisions ADD COLUMN placement jsonb
  CHECK (placement IS NULL OR jsonb_typeof(placement) = 'object');

CREATE OR REPLACE FUNCTION design_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published', 'discarded') THEN
    RAISE EXCEPTION 'design revision % is % and immutable (% rejected)', OLD.id, OLD.status, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  -- The frozen inputs of a revision never change after creation.
  IF NEW.project_id      IS DISTINCT FROM OLD.project_id
  OR NEW.cad_file_id     IS DISTINCT FROM OLD.cad_file_id
  OR NEW.rules           IS DISTINCT FROM OLD.rules
  OR NEW.mapping_version IS DISTINCT FROM OLD.mapping_version
  OR NEW.crs_epsg        IS DISTINCT FROM OLD.crs_epsg
  OR NEW.drawing_unit    IS DISTINCT FROM OLD.drawing_unit
  OR NEW.metres_per_unit IS DISTINCT FROM OLD.metres_per_unit
  OR NEW.placement       IS DISTINCT FROM OLD.placement
  OR NEW.base_revision_id IS DISTINCT FROM OLD.base_revision_id THEN
    RAISE EXCEPTION 'design revision inputs are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
