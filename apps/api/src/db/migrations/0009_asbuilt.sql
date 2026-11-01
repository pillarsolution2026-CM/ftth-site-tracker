-- 0009 Phase 4: As-Built edits, the approved As-Built state and As-Built DXF exports
-- (ADR-029, ADR-030; contracts in packages/shared/src/asbuilt, docs/phase-4-contracts.md).
--
-- The design revision is never touched. Each As-Built edit is an immutable record that arrives
-- through the Phase 3 sync path (`sync_operations`, same idempotency). Only an approved edit
-- changes `asbuilt_features`, the projection of the approved state.

ALTER TABLE sync_operations DROP CONSTRAINT sync_operations_kind_check;
ALTER TABLE sync_operations ADD CONSTRAINT sync_operations_kind_check
  CHECK (kind IN ('execution_update.record', 'asbuilt_edit.record'));

CREATE TABLE asbuilt_edits (
  id                  uuid PRIMARY KEY,
  project_id          uuid          NOT NULL REFERENCES projects (id),
  client_op_id        uuid          NOT NULL UNIQUE REFERENCES sync_operations (client_op_id),
  -- A design feature, or the new id of an added feature (no row in `features`).
  feature_id          uuid          NOT NULL,
  kind                text          NOT NULL
                        CHECK (kind IN ('move', 'reshape', 'add_route', 'add_symbol', 'label')),
  feature_type        text          NOT NULL
                        CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh')),
  design_revision_id  uuid          NOT NULL,
  -- Approved geometry version (move/reshape) or label version (label) the device drew on.
  base_version        integer       CHECK (base_version >= 0),
  -- Proposed geometry in the project CRS (metres).
  geom                geometry,
  label               text          CHECK (length(label) BETWEEN 1 AND 200),
  length_m            numeric(14, 3) GENERATED ALWAYS AS (
                        CASE WHEN feature_type = 'route' AND geom IS NOT NULL
                             THEN round(ST_Length(geom)::numeric, 3) END) STORED,
  note                text          CHECK (length(note) <= 2000),
  user_id             uuid          NOT NULL REFERENCES users (id),
  device_id           uuid          NOT NULL,
  captured_at         timestamptz   NOT NULL,   -- device clock (evidence only)
  received_at         timestamptz   NOT NULL DEFAULT now(),
  gps_wgs84           geometry(Point, 4326),    -- evidence only
  gps_accuracy_m      double precision CHECK (gps_accuracy_m >= 0),
  gps_at              timestamptz,
  flags               text[]        NOT NULL DEFAULT '{}',
  status              text          NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),
  review_reason       text          CHECK (length(review_reason) <= 2000),
  reviewed_by         uuid          REFERENCES users (id),
  reviewed_at         timestamptz,
  approved_version    integer       CHECK (approved_version >= 1),
  sync_seq            bigint        NOT NULL DEFAULT nextval('execution_sync_seq'),
  CONSTRAINT asbuilt_edits_project_id_id_key UNIQUE (project_id, id),
  CONSTRAINT asbuilt_edits_revision_fkey
    FOREIGN KEY (project_id, design_revision_id) REFERENCES design_revisions (project_id, id),
  CONSTRAINT asbuilt_edits_srid CHECK (geom IS NULL OR is_supported_project_epsg(ST_SRID(geom))),
  CONSTRAINT asbuilt_edits_shape CHECK (
    (kind IN ('move', 'add_symbol') AND GeometryType(geom) = 'POINT' AND feature_type <> 'route') OR
    (kind IN ('reshape', 'add_route') AND GeometryType(geom) = 'LINESTRING' AND feature_type = 'route') OR
    (kind = 'label' AND geom IS NULL AND label IS NOT NULL)),
  CONSTRAINT asbuilt_edits_label_only_where_meaningful CHECK (
    label IS NULL OR kind IN ('label', 'add_route', 'add_symbol')),
  CONSTRAINT asbuilt_edits_base CHECK ((base_version IS NULL) = (kind IN ('add_route', 'add_symbol'))),
  CONSTRAINT asbuilt_edits_gps_complete CHECK ((gps_wgs84 IS NULL) = (gps_at IS NULL)),
  CONSTRAINT asbuilt_edits_review_complete CHECK (
    (status = 'pending') = (reviewed_at IS NULL) AND
    (status = 'pending') = (reviewed_by IS NULL) AND
    (status = 'approved') = (approved_version IS NOT NULL) AND
    (status <> 'rejected' OR review_reason IS NOT NULL))
);
CREATE INDEX asbuilt_edits_project_seq_idx ON asbuilt_edits (project_id, sync_seq);
CREATE INDEX asbuilt_edits_feature_idx ON asbuilt_edits (project_id, feature_id);
CREATE INDEX asbuilt_edits_status_idx ON asbuilt_edits (project_id, status, received_at);
-- One add per new feature id, ever (a rejected add keeps its id: the device draws a new one).
CREATE UNIQUE INDEX asbuilt_edits_one_add_idx ON asbuilt_edits (feature_id)
  WHERE kind IN ('add_route', 'add_symbol');

-- Approved As-Built state (projection of approved edits). A design feature without a row is
-- As-Built = design. `geom` NULL means "the design geometry still applies" (only a label approved).
CREATE TABLE asbuilt_features (
  project_id         uuid          NOT NULL REFERENCES projects (id),
  feature_id         uuid          NOT NULL,
  feature_type       text          NOT NULL
                       CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh')),
  added              boolean       NOT NULL,
  geom               geometry,
  length_m           numeric(14, 3) GENERATED ALWAYS AS (
                       CASE WHEN feature_type = 'route' AND geom IS NOT NULL
                            THEN round(ST_Length(geom)::numeric, 3) END) STORED,
  label              text          CHECK (length(label) BETWEEN 1 AND 200),
  geometry_version   integer       NOT NULL DEFAULT 0 CHECK (geometry_version >= 0),
  label_version      integer       NOT NULL DEFAULT 0 CHECK (label_version >= 0),
  geometry_edit_id   uuid,
  label_edit_id      uuid,
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, feature_id),
  CONSTRAINT asbuilt_features_geometry_edit_fkey
    FOREIGN KEY (project_id, geometry_edit_id) REFERENCES asbuilt_edits (project_id, id),
  CONSTRAINT asbuilt_features_label_edit_fkey
    FOREIGN KEY (project_id, label_edit_id) REFERENCES asbuilt_edits (project_id, id),
  CONSTRAINT asbuilt_features_srid CHECK (geom IS NULL OR is_supported_project_epsg(ST_SRID(geom))),
  CONSTRAINT asbuilt_features_geom_version CHECK (
    (geom IS NULL) = (geometry_version = 0) AND (geom IS NULL) = (geometry_edit_id IS NULL)),
  CONSTRAINT asbuilt_features_added_has_geom CHECK (NOT added OR geom IS NOT NULL),
  CONSTRAINT asbuilt_features_label_version CHECK ((label_version = 0) = (label_edit_id IS NULL)),
  CONSTRAINT asbuilt_features_shape CHECK (
    geom IS NULL OR
    (feature_type = 'route' AND GeometryType(geom) = 'LINESTRING') OR
    (feature_type <> 'route' AND GeometryType(geom) = 'POINT'))
);

-- As-Built DXF exports written by the CAD worker (job `cad.export_asbuilt`).
CREATE TABLE asbuilt_exports (
  id               uuid PRIMARY KEY,
  project_id       uuid          NOT NULL REFERENCES projects (id),
  revision_id      uuid          NOT NULL,
  status           text          NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'processing', 'done', 'failed')),
  current_job_id   uuid          NOT NULL,   -- ADR-013 guard for the worker
  requested_by     uuid          NOT NULL REFERENCES users (id),
  requested_at     timestamptz   NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  storage_key      text,
  size_bytes       bigint        CHECK (size_bytes >= 0),
  sha256           text          CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  stats            jsonb         CHECK (stats IS NULL OR jsonb_typeof(stats) = 'object'),
  error_code       text,
  CONSTRAINT asbuilt_exports_project_id_id_key UNIQUE (project_id, id),
  CONSTRAINT asbuilt_exports_revision_fkey
    FOREIGN KEY (project_id, revision_id) REFERENCES design_revisions (project_id, id),
  CONSTRAINT asbuilt_exports_done_complete CHECK (
    (status = 'done') = (storage_key IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
                         AND stats IS NOT NULL)),
  CONSTRAINT asbuilt_exports_failed_has_code CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT asbuilt_exports_finished CHECK ((status IN ('done', 'failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX asbuilt_exports_project_idx ON asbuilt_exports (project_id, requested_at DESC);

-- Integrity triggers --------------------------------------------------------------------------

-- An edit targets a design feature of the project or an approved added feature; an add uses a
-- new id. Checked by the application too; this is the last line of defence.
CREATE FUNCTION asbuilt_edits_target_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  design_type text;
  added_type  text;
BEGIN
  SELECT f.feature_type INTO design_type
    FROM features f WHERE f.project_id = NEW.project_id AND f.id = NEW.feature_id;
  SELECT a.feature_type INTO added_type
    FROM asbuilt_features a
   WHERE a.project_id = NEW.project_id AND a.feature_id = NEW.feature_id AND a.added;
  IF NEW.kind IN ('add_route', 'add_symbol') THEN
    IF EXISTS (SELECT 1 FROM features f WHERE f.id = NEW.feature_id) THEN
      RAISE EXCEPTION 'asbuilt_edits: an added feature needs a new id' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF coalesce(design_type, added_type) IS NULL THEN
    RAISE EXCEPTION 'asbuilt_edits: unknown feature %', NEW.feature_id USING ERRCODE = 'foreign_key_violation';
  ELSIF coalesce(design_type, added_type) <> NEW.feature_type THEN
    RAISE EXCEPTION 'asbuilt_edits: feature type mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER asbuilt_edits_target BEFORE INSERT ON asbuilt_edits
  FOR EACH ROW EXECUTE FUNCTION asbuilt_edits_target_check();

-- A recorded edit is a fact: only a pending edit's review may change (once), and it bumps the
-- sync cursor so devices see the decision.
CREATE FUNCTION asbuilt_edits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'asbuilt_edits: a reviewed edit is final' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'review_reason', 'reviewed_by', 'reviewed_at',
                            'approved_version', 'sync_seq'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'review_reason', 'reviewed_by', 'reviewed_at',
                            'approved_version', 'sync_seq']) THEN
    RAISE EXCEPTION 'asbuilt_edits: only the review fields may change' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.sync_seq := nextval('execution_sync_seq');
  RETURN NEW;
END;
$$;
CREATE TRIGGER asbuilt_edits_immutable BEFORE UPDATE ON asbuilt_edits
  FOR EACH ROW EXECUTE FUNCTION asbuilt_edits_guard();

-- The projection only moves forward and only from an approved edit of the same feature.
CREATE FUNCTION asbuilt_features_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id <> OLD.project_id OR NEW.feature_id <> OLD.feature_id
       OR NEW.feature_type <> OLD.feature_type OR NEW.added <> OLD.added THEN
      RAISE EXCEPTION 'asbuilt_features: identity is fixed' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.geometry_version < OLD.geometry_version OR NEW.label_version < OLD.label_version THEN
      RAISE EXCEPTION 'asbuilt_features: versions only increase' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.geometry_edit_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM asbuilt_edits e
        WHERE e.project_id = NEW.project_id AND e.id = NEW.geometry_edit_id
          AND e.feature_id = NEW.feature_id AND e.status = 'approved'
          AND e.kind IN ('move', 'reshape', 'add_route', 'add_symbol')
          AND e.approved_version = NEW.geometry_version) THEN
    RAISE EXCEPTION 'asbuilt_features: geometry must come from an approved edit' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label_edit_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM asbuilt_edits e
        WHERE e.project_id = NEW.project_id AND e.id = NEW.label_edit_id
          AND e.feature_id = NEW.feature_id AND e.status = 'approved'
          AND e.label IS NOT NULL AND e.label = NEW.label) THEN
    RAISE EXCEPTION 'asbuilt_features: label must come from an approved edit' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER asbuilt_features_projection BEFORE INSERT OR UPDATE ON asbuilt_features
  FOR EACH ROW EXECUTE FUNCTION asbuilt_features_guard();

CREATE TRIGGER asbuilt_edits_no_delete BEFORE DELETE ON asbuilt_edits
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER asbuilt_features_no_delete BEFORE DELETE ON asbuilt_features
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER asbuilt_exports_no_delete BEFORE DELETE ON asbuilt_exports
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER asbuilt_edits_no_truncate BEFORE TRUNCATE ON asbuilt_edits
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER asbuilt_features_no_truncate BEFORE TRUNCATE ON asbuilt_features
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER asbuilt_exports_no_truncate BEFORE TRUNCATE ON asbuilt_exports
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();
