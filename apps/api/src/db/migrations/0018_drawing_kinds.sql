-- 0018: two drawings per work order, General and Secondary (ADR-040 part A).
-- Each CAD file has a kind chosen at upload that never changes; a newer version of the same kind
-- supersedes the older file (it stays as history); a project may have one open design revision
-- PER KIND; the two kinds are published together and share the revision number.

-- CAD files: kind and supersession ----------------------------------------------------------------

ALTER TABLE cad_files
  ADD COLUMN drawing_kind  text NOT NULL DEFAULT 'general'
    CONSTRAINT cad_files_drawing_kind_check CHECK (drawing_kind IN ('general', 'secondary')),
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN superseded_by uuid;

ALTER TABLE cad_files
  ADD CONSTRAINT cad_files_superseded_by_fkey
    FOREIGN KEY (project_id, superseded_by) REFERENCES cad_files (project_id, id),
  ADD CONSTRAINT cad_files_superseded_complete
    CHECK ((superseded_at IS NULL) = (superseded_by IS NULL)),
  ADD CONSTRAINT cad_files_superseded_not_self
    CHECK (superseded_by IS NULL OR superseded_by <> id);

-- There is deliberately no unique "one current file per kind" index: legacy projects and many tests
-- hold several files per project. The application enforces it under a lock at upload.

CREATE OR REPLACE FUNCTION cad_files_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.drawing_kind IS DISTINCT FROM OLD.drawing_kind THEN
    RAISE EXCEPTION 'cad_files: the drawing kind never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL
     AND (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
          OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by) THEN
    RAISE EXCEPTION 'cad_files: a superseded file stays superseded' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cad_files_kind_immutable BEFORE UPDATE ON cad_files
  FOR EACH ROW EXECUTE FUNCTION cad_files_kind_guard();

-- Design revisions: kind follows the source file ------------------------------------------------

ALTER TABLE design_revisions
  ADD COLUMN drawing_kind text NOT NULL DEFAULT 'general'
    CONSTRAINT design_revisions_drawing_kind_check CHECK (drawing_kind IN ('general', 'secondary'));

CREATE OR REPLACE FUNCTION design_revisions_kind_from_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file_kind text;
BEGIN
  SELECT drawing_kind INTO file_kind FROM cad_files
    WHERE project_id = NEW.project_id AND id = NEW.cad_file_id;
  IF file_kind IS NULL OR file_kind <> NEW.drawing_kind THEN
    RAISE EXCEPTION 'design revision kind % does not match its CAD file kind %', NEW.drawing_kind, file_kind
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER design_revisions_kind_from_file BEFORE INSERT ON design_revisions
  FOR EACH ROW EXECUTE FUNCTION design_revisions_kind_from_file();

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
  OR NEW.drawing_kind    IS DISTINCT FROM OLD.drawing_kind
  OR NEW.rules           IS DISTINCT FROM OLD.rules
  OR NEW.mapping_version IS DISTINCT FROM OLD.mapping_version
  OR NEW.crs_epsg        IS DISTINCT FROM OLD.crs_epsg
  OR NEW.drawing_unit    IS DISTINCT FROM OLD.drawing_unit
  OR NEW.metres_per_unit IS DISTINCT FROM OLD.metres_per_unit
  OR NEW.placement       IS DISTINCT FROM OLD.placement
  OR NEW.corrections     IS DISTINCT FROM OLD.corrections
  OR NEW.base_revision_id IS DISTINCT FROM OLD.base_revision_id THEN
    RAISE EXCEPTION 'design revision inputs are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- One open revision per project AND kind (was one per project) -----------------------------------

DROP INDEX design_revisions_one_open_idx;
CREATE UNIQUE INDEX design_revisions_one_open_idx ON design_revisions (project_id, drawing_kind)
  WHERE status IN ('queued', 'building', 'draft');

-- Both kinds are published together with the SAME rev_no, so the number is unique per kind.
ALTER TABLE design_revisions DROP CONSTRAINT design_revisions_rev_no_key;
ALTER TABLE design_revisions
  ADD CONSTRAINT design_revisions_rev_no_key UNIQUE (project_id, drawing_kind, rev_no);
