-- 0011 Drawing problems ignored on the user's own responsibility (ADR-034; issue #32).
--
-- The problems themselves are in `design_revisions.warnings` (written by the worker). A user who
-- judges a place fine ignores it here: one row per (revision, code, handle), with who and when.
-- Like every child of a revision, the rows freeze when the revision is published or discarded.

CREATE TABLE drawing_problem_ignores (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid        NOT NULL,
  revision_id  uuid        NOT NULL,
  code         text        NOT NULL CHECK (code IN ('ROUTE_SPLIT', 'RING_LABEL_MISMATCH',
                 'WRONG_LAYER', 'LABEL_MISSING', 'LABEL_TYPE_MISMATCH', 'LABEL_LENGTH_MISSING')),
  handle       text        NOT NULL CHECK (length(handle) BETWEEN 1 AND 64),
  ignored_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
  ignored_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drawing_problem_ignores_revision_fkey
    FOREIGN KEY (project_id, revision_id) REFERENCES design_revisions (project_id, id) ON DELETE CASCADE,
  CONSTRAINT drawing_problem_ignores_place_key UNIQUE (revision_id, code, handle)
);

CREATE TRIGGER drawing_problem_ignores_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON drawing_problem_ignores
  FOR EACH ROW EXECUTE FUNCTION design_revision_children_guard();
