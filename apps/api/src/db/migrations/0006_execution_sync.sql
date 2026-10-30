-- 0006 Phase 3: execution updates recorded offline by supervisors, idempotent sync, resumable photos
-- (ADR-023, ADR-024).

-- Server-side order of changes for the pull cursor. Never derived from a device clock.
CREATE SEQUENCE execution_sync_seq;

-- One row per client operation ever applied: the idempotency record. Append-only.
CREATE TABLE sync_operations (
  client_op_id    uuid PRIMARY KEY,
  project_id      uuid        NOT NULL REFERENCES projects (id),
  user_id         uuid        NOT NULL REFERENCES users (id),
  device_id       uuid        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('execution_update.record')),
  -- SHA-256 of the canonical JSON of the operation (kind, capturedAt, payload).
  payload_sha256  text        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  result          jsonb       NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_operations_project_idx ON sync_operations (project_id, received_at);

CREATE TABLE execution_updates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid          NOT NULL REFERENCES projects (id),
  client_op_id           uuid          NOT NULL UNIQUE REFERENCES sync_operations (client_op_id),
  feature_id             uuid          NOT NULL,
  feature_type           text          NOT NULL
                           CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh')),
  design_revision_id     uuid          NOT NULL,
  work_type              text          NOT NULL CHECK (work_type IN ('civil', 'installation', 'planning')),
  user_id                uuid          NOT NULL REFERENCES users (id),
  device_id              uuid          NOT NULL,
  captured_at            timestamptz   NOT NULL,   -- device clock (evidence only)
  received_at            timestamptz   NOT NULL DEFAULT now(),
  label                  text          CHECK (length(label) <= 200),
  note                   text          CHECK (length(note) <= 2000),
  gps_wgs84              geometry(Point, 4326),    -- raw fix as reported by the device
  gps_accuracy_m         double precision CHECK (gps_accuracy_m >= 0),
  gps_at                 timestamptz,
  gps_geom               geometry(Point),          -- the fix in the project CRS
  gps_distance_m         numeric(14, 3) CHECK (gps_distance_m >= 0),
  flags                  text[]        NOT NULL DEFAULT '{}',
  acknowledged_warnings  text[]        NOT NULL DEFAULT '{}',
  status                 text          NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected')),
  review_reason          text          CHECK (length(review_reason) <= 2000),
  reviewed_by            uuid          REFERENCES users (id),
  reviewed_at            timestamptz,
  sync_seq               bigint        NOT NULL DEFAULT nextval('execution_sync_seq'),
  CONSTRAINT execution_updates_project_id_id_key UNIQUE (project_id, id),
  CONSTRAINT execution_updates_feature_fkey
    FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id),
  CONSTRAINT execution_updates_revision_fkey
    FOREIGN KEY (project_id, design_revision_id) REFERENCES design_revisions (project_id, id),
  CONSTRAINT execution_updates_gps_complete CHECK (
    (gps_wgs84 IS NULL) = (gps_geom IS NULL) AND (gps_wgs84 IS NULL) = (gps_at IS NULL)),
  CONSTRAINT execution_updates_gps_srid CHECK (gps_geom IS NULL OR is_supported_project_epsg(ST_SRID(gps_geom)))
);
CREATE INDEX execution_updates_project_seq_idx ON execution_updates (project_id, sync_seq);
CREATE INDEX execution_updates_feature_idx ON execution_updates (project_id, feature_id);

-- Work items (step 2) and materials (step 3) of an update. Immutable.
CREATE TABLE execution_update_lines (
  update_id           uuid           NOT NULL,
  project_id          uuid           NOT NULL,
  line_no             integer        NOT NULL CHECK (line_no >= 1),
  role                text           NOT NULL CHECK (role IN ('work', 'material')),
  work_order_item_id  uuid           NOT NULL,
  quantity            numeric(18, 4) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (update_id, line_no),
  CONSTRAINT execution_update_lines_update_fkey
    FOREIGN KEY (project_id, update_id) REFERENCES execution_updates (project_id, id),
  -- An item with recorded execution cannot be deleted (the API answers 409).
  CONSTRAINT execution_update_lines_item_fkey
    FOREIGN KEY (project_id, work_order_item_id) REFERENCES work_order_items (project_id, id),
  CONSTRAINT execution_update_lines_item_key UNIQUE (update_id, role, work_order_item_id)
);
CREATE INDEX execution_update_lines_item_idx ON execution_update_lines (work_order_item_id);

-- Photo metadata arrives with the update; bytes follow through the resumable upload.
CREATE TABLE execution_photos (
  id               uuid PRIMARY KEY,                 -- client-generated photoId
  project_id       uuid        NOT NULL,
  update_id        uuid        NOT NULL,
  requirement_key  text        NOT NULL CHECK (requirement_key ~ '^[a-z0-9_]{1,64}$'),
  sha256           text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes       integer     NOT NULL CHECK (size_bytes > 0),
  content_type     text        NOT NULL CHECK (content_type = 'image/jpeg'),
  taken_at         timestamptz NOT NULL,             -- device clock
  gps_wgs84        geometry(Point, 4326),
  gps_accuracy_m   double precision CHECK (gps_accuracy_m >= 0),
  received_bytes   integer     NOT NULL DEFAULT 0,
  storage_key      text        UNIQUE,
  stored_at        timestamptz,
  CONSTRAINT execution_photos_update_fkey
    FOREIGN KEY (project_id, update_id) REFERENCES execution_updates (project_id, id),
  CONSTRAINT execution_photos_received_range CHECK (received_bytes BETWEEN 0 AND size_bytes),
  CONSTRAINT execution_photos_stored_complete CHECK (
    (stored_at IS NULL) = (storage_key IS NULL) AND
    (stored_at IS NULL OR received_bytes = size_bytes))
);
CREATE INDEX execution_photos_update_idx ON execution_photos (update_id);

-- Bytes of an upload in progress; deleted once the photo is stored or the checksum fails.
CREATE TABLE execution_photo_chunks (
  photo_id      uuid    NOT NULL REFERENCES execution_photos (id) ON DELETE CASCADE,
  offset_bytes  integer NOT NULL CHECK (offset_bytes >= 0),
  data          bytea   NOT NULL CHECK (length(data) > 0),
  PRIMARY KEY (photo_id, offset_bytes)
);

-- Immutability -----------------------------------------------------------------------------------

CREATE FUNCTION execution_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER sync_operations_append_only BEFORE UPDATE OR DELETE ON sync_operations
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER execution_update_lines_append_only BEFORE UPDATE OR DELETE ON execution_update_lines
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER execution_updates_no_delete BEFORE DELETE ON execution_updates
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER execution_photos_no_delete BEFORE DELETE ON execution_photos
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();

CREATE TRIGGER sync_operations_no_truncate BEFORE TRUNCATE ON sync_operations
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER execution_updates_no_truncate BEFORE TRUNCATE ON execution_updates
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER execution_update_lines_no_truncate BEFORE TRUNCATE ON execution_update_lines
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER execution_photos_no_truncate BEFORE TRUNCATE ON execution_photos
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();

-- A recorded update is a fact: only the review (Phase 5) may change, and it bumps the sync cursor.
CREATE FUNCTION execution_updates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'review_reason', 'reviewed_by', 'reviewed_at', 'sync_seq'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'review_reason', 'reviewed_by', 'reviewed_at', 'sync_seq']) THEN
    RAISE EXCEPTION 'execution_updates: only the review fields may change' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.sync_seq := nextval('execution_sync_seq');
  RETURN NEW;
END;
$$;
CREATE TRIGGER execution_updates_immutable BEFORE UPDATE ON execution_updates
  FOR EACH ROW EXECUTE FUNCTION execution_updates_guard();

-- Photo metadata is fixed; only the upload progress may change, and a stored photo never again.
CREATE FUNCTION execution_photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stored_at IS NOT NULL THEN
    RAISE EXCEPTION 'execution_photos: a stored photo is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['received_bytes', 'storage_key', 'stored_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['received_bytes', 'storage_key', 'stored_at']) THEN
    RAISE EXCEPTION 'execution_photos: metadata is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER execution_photos_immutable BEFORE UPDATE ON execution_photos
  FOR EACH ROW EXECUTE FUNCTION execution_photos_guard();
