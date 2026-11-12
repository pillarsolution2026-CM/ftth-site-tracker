-- Test-only stand-in for apps/api migration 0023_box_types.sql (ADR-043), applied by conftest
-- ONLY when that migration is not in the tree yet. Just the part the worker reads and writes;
-- the API's migration is the source of truth and replaces this file once merged.

ALTER TABLE cad_inserts ADD COLUMN shape_signature text
  CHECK (shape_signature IS NULL OR shape_signature ~ '^(v[1-9][0-9]{0,2}-[0-9a-f]{64}|none)$');

CREATE TABLE cad_file_shapes (
  project_id      uuid  NOT NULL,
  cad_file_id     uuid  NOT NULL,
  shape_signature text  NOT NULL CHECK (shape_signature ~ '^v[1-9][0-9]{0,2}-[0-9a-f]{64}$'),
  preview         jsonb CHECK (preview IS NULL OR jsonb_typeof(preview) = 'object'),
  PRIMARY KEY (cad_file_id, shape_signature),
  CONSTRAINT cad_file_shapes_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id) ON DELETE CASCADE
);

ALTER TABLE design_revisions ADD COLUMN box_shapes jsonb;
ALTER TABLE design_revisions ADD COLUMN box_types jsonb;
ALTER TABLE design_revisions ADD CONSTRAINT design_revisions_box_shapes_check
  CHECK (box_shapes IS NULL OR (jsonb_typeof(box_shapes) = 'object' AND drawing_kind = 'secondary'));
ALTER TABLE design_revisions ADD CONSTRAINT design_revisions_box_types_check
  CHECK (box_types IS NULL OR (jsonb_typeof(box_types) = 'object' AND drawing_kind = 'secondary'));
