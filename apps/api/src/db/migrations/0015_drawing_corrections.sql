-- 0015 Drawing corrections made on the program page (ADR-038 part 2).
--
-- The drawing file never changes. A correction (move a layer, edit or add a text, add an item,
-- merge route pieces: DrawingCorrectionInput in @ftth/shared) is stored with the CAD file and
-- applied by the worker to the extracted rows before classification. A revision freezes the
-- corrections in force at creation in `design_revisions.corrections` ([{id, correction}] in
-- creation order), like the rules and the placement.
--
-- A correction is a fact: the only change ever allowed is the withdrawal, once
-- (withdrawn_by / withdrawn_at from NULL to set). Never deleted.

CREATE TABLE cad_file_corrections (
  id             uuid PRIMARY KEY,
  project_id     uuid        NOT NULL,
  cad_file_id    uuid        NOT NULL,
  correction     jsonb       NOT NULL CHECK (jsonb_typeof(correction) = 'object'),
  -- The problem place this correction answers (context only, not checked against the revision).
  problem_code   text        CHECK (problem_code IN ('ROUTE_SPLIT', 'RING_LABEL_MISMATCH',
                   'WRONG_LAYER', 'LABEL_MISSING', 'LABEL_TYPE_MISMATCH', 'LABEL_LENGTH_MISSING')),
  problem_handle text        CHECK (length(problem_handle) BETWEEN 1 AND 64),
  created_by     uuid        REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  withdrawn_by   uuid        REFERENCES users (id),
  withdrawn_at   timestamptz,
  CONSTRAINT cad_file_corrections_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id),
  CONSTRAINT cad_file_corrections_problem_both CHECK ((problem_code IS NULL) = (problem_handle IS NULL)),
  CONSTRAINT cad_file_corrections_withdrawal_both CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);
CREATE INDEX cad_file_corrections_file_idx
  ON cad_file_corrections (project_id, cad_file_id, created_at, id);

CREATE FUNCTION cad_file_corrections_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'cad_file_corrections: a withdrawn correction is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['withdrawn_by', 'withdrawn_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['withdrawn_by', 'withdrawn_at']) THEN
    RAISE EXCEPTION 'cad_file_corrections: only the withdrawal may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cad_file_corrections_immutable BEFORE UPDATE ON cad_file_corrections
  FOR EACH ROW EXECUTE FUNCTION cad_file_corrections_guard();
CREATE TRIGGER cad_file_corrections_no_delete BEFORE DELETE ON cad_file_corrections
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER cad_file_corrections_no_truncate BEFORE TRUNCATE ON cad_file_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();

-- Frozen on the revision with the other build inputs --------------------------------------------

ALTER TABLE design_revisions ADD COLUMN corrections jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(corrections) = 'array');

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
  OR NEW.corrections     IS DISTINCT FROM OLD.corrections
  OR NEW.base_revision_id IS DISTINCT FROM OLD.base_revision_id THEN
    RAISE EXCEPTION 'design revision inputs are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
