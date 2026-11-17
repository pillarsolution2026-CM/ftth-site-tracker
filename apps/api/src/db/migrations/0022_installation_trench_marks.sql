-- 0022 How the General's bundles are installed: pull through existing pipes, or trench (ADR-040
-- G14–G17, ADR-042 part D).
--
-- After uploading a General the PM answers «المسار كله سحب في مواسير قديمة، ولا فيه جزء محتاج حفر
-- وتركيب مواسير؟» (InstallationAnswer in @ftth/shared: pull_only | has_trench). With has_trench the
-- PM marks the trench parts on the drawing viewer: a route handle of the file and the WRITTEN
-- length in metres; the rest stays pull. A Secondary is never asked (all trench).
--
-- Both are facts of the GENERAL CAD FILE, never deleted:
-- - an answer row never changes; the latest row (seq) is the answer in force;
-- - a trench mark only changes by its withdrawal, once (as cad_file_corrections, 0015).
-- A design revision freezes the answer and the marks in force at creation in
-- `design_revisions.installation` (FrozenInstallation), like the rules, placement and corrections.

CREATE FUNCTION cad_file_must_be_general() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT drawing_kind FROM cad_files WHERE project_id = NEW.project_id AND id = NEW.cad_file_id)
     IS DISTINCT FROM 'general' THEN
    RAISE EXCEPTION '%: only a General drawing has an installation answer or trench marks', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Answers ------------------------------------------------------------------------------------------

CREATE TABLE cad_file_installation_answers (
  id          uuid PRIMARY KEY,
  project_id  uuid        NOT NULL,
  cad_file_id uuid        NOT NULL,
  answer      text        NOT NULL CHECK (answer IN ('pull_only', 'has_trench')),
  created_by  uuid        REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Order of the rows of a file: independent of clocks and ids (inserts run under the file lock).
  seq         bigserial   NOT NULL,
  CONSTRAINT cad_file_installation_answers_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id)
);
CREATE INDEX cad_file_installation_answers_file_idx
  ON cad_file_installation_answers (project_id, cad_file_id, seq);

CREATE TRIGGER cad_file_installation_answers_general BEFORE INSERT ON cad_file_installation_answers
  FOR EACH ROW EXECUTE FUNCTION cad_file_must_be_general();
CREATE TRIGGER cad_file_installation_answers_no_update BEFORE UPDATE ON cad_file_installation_answers
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER cad_file_installation_answers_no_delete BEFORE DELETE ON cad_file_installation_answers
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER cad_file_installation_answers_no_truncate BEFORE TRUNCATE ON cad_file_installation_answers
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();

-- Trench marks -------------------------------------------------------------------------------------

CREATE TABLE cad_file_trench_marks (
  id           uuid PRIMARY KEY,
  project_id   uuid          NOT NULL,
  cad_file_id  uuid          NOT NULL,
  -- Drawing handle of the route piece picked on the viewer (resolved through merges at check time).
  route_handle text          NOT NULL CHECK (length(route_handle) BETWEEN 1 AND 64),
  -- Written trench length; MAX_TRENCH_MARK_M in @ftth/shared.
  length_m     numeric(9, 3) NOT NULL CHECK (length_m > 0 AND length_m <= 100000),
  created_by   uuid          REFERENCES users (id),
  created_at   timestamptz   NOT NULL DEFAULT now(),
  seq          bigserial     NOT NULL,
  withdrawn_by uuid          REFERENCES users (id),
  withdrawn_at timestamptz,
  CONSTRAINT cad_file_trench_marks_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id),
  CONSTRAINT cad_file_trench_marks_withdrawal_both CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);
CREATE INDEX cad_file_trench_marks_file_idx
  ON cad_file_trench_marks (project_id, cad_file_id, seq);

CREATE FUNCTION cad_file_trench_marks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'cad_file_trench_marks: a withdrawn mark is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['withdrawn_by', 'withdrawn_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['withdrawn_by', 'withdrawn_at']) THEN
    RAISE EXCEPTION 'cad_file_trench_marks: only the withdrawal may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cad_file_trench_marks_general BEFORE INSERT ON cad_file_trench_marks
  FOR EACH ROW EXECUTE FUNCTION cad_file_must_be_general();
CREATE TRIGGER cad_file_trench_marks_immutable BEFORE UPDATE ON cad_file_trench_marks
  FOR EACH ROW EXECUTE FUNCTION cad_file_trench_marks_guard();
CREATE TRIGGER cad_file_trench_marks_no_delete BEFORE DELETE ON cad_file_trench_marks
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER cad_file_trench_marks_no_truncate BEFORE TRUNCATE ON cad_file_trench_marks
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();

-- Frozen on the revision with the other build inputs ------------------------------------------------

-- NULL on a Secondary and on revisions built before this migration (a General then reads as
-- unanswered: QUESTION_UNANSWERED blocks publishing until it is answered and rebuilt).
ALTER TABLE design_revisions ADD COLUMN installation jsonb;
ALTER TABLE design_revisions ADD CONSTRAINT design_revisions_installation_check
  CHECK (installation IS NULL OR (jsonb_typeof(installation) = 'object' AND drawing_kind = 'general'));

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
  OR NEW.installation    IS DISTINCT FROM OLD.installation
  OR NEW.base_revision_id IS DISTINCT FROM OLD.base_revision_id THEN
    RAISE EXCEPTION 'design revision inputs are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
