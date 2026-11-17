-- 0023 Box type by the drawn shape (ADR-040 part E, ADR-043).
--
-- Boxes carry no type text: the worker groups them by the DRAWN SHAPE of their symbol (a signature
-- `v<version>-<sha256>` or `none`), the revision lists the shapes (a gallery), and the PM picks, in
-- front of each shape, a line of the project's work order. The choices belong to the Secondary CAD
-- FILE (append-only, the latest row per shape is in force) and are frozen on the revision at creation.

-- Import output ------------------------------------------------------------------------------------

-- NULL on files processed before this migration (BOX_SHAPE_UNKNOWN until the file is reprocessed).
ALTER TABLE cad_inserts ADD COLUMN shape_signature text;
ALTER TABLE cad_inserts ADD CONSTRAINT cad_inserts_shape_signature_check
  CHECK (shape_signature IS NULL OR shape_signature ~ '^(v[1-9][0-9]{0,2}-[0-9a-f]{64}|none)$');

-- One row per distinct insert signature of a file, with its preview (replaced on reprocess; the
-- worker writes it). `preview` is NULL past MAX_FILE_SHAPES.
CREATE TABLE cad_file_shapes (
  project_id      uuid    NOT NULL,
  cad_file_id     uuid    NOT NULL,
  shape_signature text    NOT NULL
    CONSTRAINT cad_file_shapes_signature_check
    CHECK (shape_signature ~ '^(v[1-9][0-9]{0,2}-[0-9a-f]{64}|none)$'),
  insert_count    integer NOT NULL CHECK (insert_count >= 1),
  block_names     jsonb   NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(block_names) = 'array'),
  preview         jsonb   CHECK (preview IS NULL OR jsonb_typeof(preview) = 'object'),
  PRIMARY KEY (cad_file_id, shape_signature),
  CONSTRAINT cad_file_shapes_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id) ON DELETE CASCADE
);

-- The PM's choices ---------------------------------------------------------------------------------

CREATE FUNCTION cad_file_must_be_secondary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT drawing_kind FROM cad_files WHERE project_id = NEW.project_id AND id = NEW.cad_file_id)
     IS DISTINCT FROM 'secondary' THEN
    RAISE EXCEPTION '%: only a Secondary drawing has box types', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- The line must be a line of THIS project's work order. No FK: a line may still be removed in the
-- work-orders module (ADR-028); the check at readiness / publish catches that (BOX_TYPE_LINE_MISSING).
CREATE FUNCTION box_type_choice_line_in_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_order_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM work_order_items i
      JOIN work_orders o ON o.id = i.work_order_id
     WHERE i.id = NEW.work_order_item_id AND o.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'cad_file_box_type_choices: the line is not a line of the project work order'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE cad_file_box_type_choices (
  id                 uuid PRIMARY KEY,
  project_id         uuid        NOT NULL,
  cad_file_id        uuid        NOT NULL,
  shape_signature    text        NOT NULL
    CONSTRAINT cad_file_box_type_choices_shape_check
    CHECK (shape_signature ~ '^(v[1-9][0-9]{0,2}-[0-9a-f]{64}|none)$'),
  -- NULL = cleared back to unset.
  work_order_item_id uuid,
  created_by         uuid        REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Order of the rows of a file: independent of clocks and ids (inserts run under the file lock).
  seq                bigserial   NOT NULL,
  CONSTRAINT cad_file_box_type_choices_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id)
);
CREATE INDEX cad_file_box_type_choices_file_idx
  ON cad_file_box_type_choices (project_id, cad_file_id, seq);

CREATE TRIGGER cad_file_box_type_choices_secondary BEFORE INSERT ON cad_file_box_type_choices
  FOR EACH ROW EXECUTE FUNCTION cad_file_must_be_secondary();
CREATE TRIGGER cad_file_box_type_choices_line BEFORE INSERT ON cad_file_box_type_choices
  FOR EACH ROW EXECUTE FUNCTION box_type_choice_line_in_project();
CREATE TRIGGER cad_file_box_type_choices_no_update BEFORE UPDATE ON cad_file_box_type_choices
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER cad_file_box_type_choices_no_delete BEFORE DELETE ON cad_file_box_type_choices
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER cad_file_box_type_choices_no_truncate BEFORE TRUNCATE ON cad_file_box_type_choices
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();

-- On the revision ----------------------------------------------------------------------------------

-- box_shapes: build output (BoxShapeGallery, written by the worker); box_types: frozen input
-- (FrozenBoxTypes). Both NULL on a General, in legacy reading mode and before this migration.
ALTER TABLE design_revisions ADD COLUMN box_shapes jsonb;
ALTER TABLE design_revisions ADD COLUMN box_types jsonb;
ALTER TABLE design_revisions ADD CONSTRAINT design_revisions_box_shapes_check
  CHECK (box_shapes IS NULL OR (jsonb_typeof(box_shapes) = 'object' AND drawing_kind = 'secondary'));
ALTER TABLE design_revisions ADD CONSTRAINT design_revisions_box_types_check
  CHECK (box_types IS NULL OR (jsonb_typeof(box_types) = 'object' AND drawing_kind = 'secondary'));

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
  OR NEW.box_types       IS DISTINCT FROM OLD.box_types
  OR NEW.base_revision_id IS DISTINCT FROM OLD.base_revision_id THEN
    RAISE EXCEPTION 'design revision inputs are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
