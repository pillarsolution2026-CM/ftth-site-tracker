-- 0005 Phase 1b: CAD mapping, design revisions (immutable once published), stable features,
-- text links, revision diff, and the read-only tile function for Martin (ADR-017..021).
-- Geometry of design data is in the revision CRS (WGS 84 / UTM, metres): drawing coordinates
-- multiplied by metres_per_unit (the PM's drawing unit, ADR-018) with SRID = crs_epsg.

-- CRS suggested by the worker from the extents (CrsDetection JSON); NULL for files processed before 1b.
ALTER TABLE cad_files ADD COLUMN crs_detection jsonb
  CHECK (crs_detection IS NULL OR jsonb_typeof(crs_detection) = 'object');

CREATE FUNCTION is_supported_project_epsg(epsg integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT epsg BETWEEN 32601 AND 32660 OR epsg BETWEEN 32701 AND 32760 $$;

-- Drawing unit → metres (exact). Kept in SQL so a revision's factor is checked against its unit.
CREATE FUNCTION drawing_unit_metres(unit text) RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE unit
    WHEN 'm' THEN 1::numeric WHEN 'cm' THEN 0.01 WHEN 'mm' THEN 0.001 WHEN 'km' THEN 1000
    WHEN 'in' THEN 0.0254 WHEN 'ft' THEN 0.3048 END
$$;

-- One editable mapping per CAD file (CadMappingInput). Revisions keep their own frozen copy.
CREATE TABLE cad_mappings (
  cad_file_id      uuid PRIMARY KEY,
  project_id       uuid          NOT NULL,
  rules            jsonb         NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  crs_epsg         integer       NOT NULL CHECK (is_supported_project_epsg(crs_epsg)),
  drawing_unit     text          NOT NULL CHECK (drawing_unit_metres(drawing_unit) IS NOT NULL),
  metres_per_unit  numeric(12, 6) NOT NULL,
  version          integer       NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by       uuid          REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT cad_mappings_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id) ON DELETE CASCADE,
  CONSTRAINT cad_mappings_unit_factor CHECK (metres_per_unit = drawing_unit_metres(drawing_unit))
);
CREATE TRIGGER cad_mappings_set_updated_at
  BEFORE UPDATE ON cad_mappings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE design_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid          NOT NULL REFERENCES projects (id),
  cad_file_id       uuid          NOT NULL,
  rev_no            integer       CHECK (rev_no >= 1),          -- assigned on publish
  status            text          NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'building', 'draft', 'failed', 'published', 'discarded')),
  current_job_id    uuid          NOT NULL,                     -- ADR-013 guard for the worker
  base_revision_id  uuid,                                       -- last published at creation
  rules             jsonb         NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  mapping_version   integer       NOT NULL,
  crs_epsg          integer       NOT NULL CHECK (is_supported_project_epsg(crs_epsg)),
  drawing_unit      text          NOT NULL CHECK (drawing_unit_metres(drawing_unit) IS NOT NULL),
  metres_per_unit   numeric(12, 6) NOT NULL,
  ins_units         integer,
  units_conflict    boolean       NOT NULL DEFAULT false,
  counts            jsonb,        -- DesignRevisionCounts
  text_link_counts  jsonb,        -- TextLinkCounts
  diff_counts       jsonb,        -- DiffCounts
  tiles_storage_key text,         -- PMTiles archive (background + network)
  warnings          jsonb         NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  log               text,
  error_code        text,
  error_message     text,
  created_by        uuid          REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  queued_at         timestamptz   NOT NULL DEFAULT now(),
  build_started_at  timestamptz,
  built_at          timestamptz,
  published_at      timestamptz,
  published_by      uuid          REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT design_revisions_project_id_id_key UNIQUE (project_id, id),
  CONSTRAINT design_revisions_rev_no_key UNIQUE (project_id, rev_no),
  -- A published revision keeps its source file: no cascade from cad_files.
  CONSTRAINT design_revisions_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT design_revisions_base_fkey
    FOREIGN KEY (project_id, base_revision_id) REFERENCES design_revisions (project_id, id),
  CONSTRAINT design_revisions_unit_factor CHECK (metres_per_unit = drawing_unit_metres(drawing_unit)),
  CONSTRAINT design_revisions_published_complete CHECK (
    (status = 'published') = (rev_no IS NOT NULL) AND
    (status = 'published') = (published_at IS NOT NULL)),
  CONSTRAINT design_revisions_failed_has_code CHECK ((status = 'failed') = (error_code IS NOT NULL))
);
-- At most one revision per project in progress (queued, building or draft).
CREATE UNIQUE INDEX design_revisions_one_open_idx ON design_revisions (project_id)
  WHERE status IN ('queued', 'building', 'draft');
CREATE INDEX design_revisions_project_created_idx ON design_revisions (project_id, created_at DESC);
CREATE TRIGGER design_revisions_set_updated_at
  BEFORE UPDATE ON design_revisions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Stable feature identity: one row per feature ever created; never updated.
CREATE TABLE features (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid        NOT NULL REFERENCES projects (id),
  feature_type       text        NOT NULL CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh')),
  first_revision_id  uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT features_project_id_id_key UNIQUE (project_id, id),
  CONSTRAINT features_first_revision_fkey
    FOREIGN KEY (project_id, first_revision_id) REFERENCES design_revisions (project_id, id)
);

-- A feature as drawn in one revision.
CREATE TABLE design_features (
  revision_id    uuid          NOT NULL,
  feature_id     uuid          NOT NULL,
  project_id     uuid          NOT NULL,
  feature_type   text          NOT NULL CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh')),
  code           text,
  layer          text          NOT NULL,
  block_name     text,
  source_kind    text          NOT NULL CHECK (source_kind IN ('curve', 'insert', 'text')),
  source_handle  text          NOT NULL,
  geom           geometry      NOT NULL,
  -- Metres in the revision CRS (geometry is already scaled by metres_per_unit).
  length_m       numeric(14, 3) GENERATED ALWAYS AS (
                   CASE WHEN feature_type = 'route' THEN round(ST_Length(geom)::numeric, 3) END) STORED,
  attrs          jsonb         NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attrs) = 'object'),
  PRIMARY KEY (revision_id, feature_id),
  CONSTRAINT design_features_revision_fkey
    FOREIGN KEY (project_id, revision_id) REFERENCES design_revisions (project_id, id) ON DELETE CASCADE,
  CONSTRAINT design_features_feature_fkey
    FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id),
  CONSTRAINT design_features_handle_key UNIQUE (revision_id, source_kind, source_handle),
  CONSTRAINT design_features_srid CHECK (is_supported_project_epsg(ST_SRID(geom))),
  CONSTRAINT design_features_geometry_kind CHECK (
    (feature_type = 'route') = (GeometryType(geom) = 'LINESTRING') AND
    (feature_type <> 'route') = (GeometryType(geom) = 'POINT'))
);
CREATE INDEX design_features_revision_type_idx ON design_features (revision_id, feature_type);
CREATE INDEX design_features_feature_idx ON design_features (feature_id);
CREATE INDEX design_features_geom_gix ON design_features USING gist (geom);

CREATE TABLE text_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid          NOT NULL,
  revision_id   uuid          NOT NULL,
  text_handle   text          NOT NULL,
  layer         text          NOT NULL,
  text          text,                          -- decoded; NULL when unreadable (never guessed)
  raw_text      text          NOT NULL,
  readable      boolean       NOT NULL,
  position      geometry(Point) NOT NULL,      -- revision CRS
  height_m      double precision NOT NULL,
  kind          text          NOT NULL
                  CHECK (kind IN ('cable', 'duct', 'length', 'box_id', 'box_bpu', 'other', 'unreadable')),
  status        text          NOT NULL CHECK (status IN ('auto', 'review', 'confirmed', 'rejected', 'unlinked')),
  feature_id    uuid,
  distance_m    numeric(12, 3),
  confidence    numeric(4, 3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  reviewed_by   uuid          REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  CONSTRAINT text_links_revision_fkey
    FOREIGN KEY (project_id, revision_id) REFERENCES design_revisions (project_id, id) ON DELETE CASCADE,
  CONSTRAINT text_links_feature_fkey
    FOREIGN KEY (revision_id, feature_id) REFERENCES design_features (revision_id, feature_id) ON DELETE CASCADE,
  CONSTRAINT text_links_handle_key UNIQUE (revision_id, text_handle),
  CONSTRAINT text_links_readable_text CHECK (readable = (text IS NOT NULL)),
  CONSTRAINT text_links_unreadable_kind CHECK (readable OR kind = 'unreadable'),
  CONSTRAINT text_links_feature_status CHECK (
    (status IN ('auto', 'confirmed') AND feature_id IS NOT NULL) OR status IN ('review', 'rejected', 'unlinked')),
  CONSTRAINT text_links_distance CHECK ((feature_id IS NULL) = (distance_m IS NULL))
);
-- Review list: least confident first.
CREATE INDEX text_links_review_idx ON text_links (revision_id, status, confidence, text_handle);
CREATE INDEX text_links_feature_idx ON text_links (revision_id, feature_id);

CREATE TABLE revision_diff_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid          NOT NULL,
  revision_id          uuid          NOT NULL,
  feature_id           uuid          NOT NULL,
  feature_type         text          NOT NULL,
  change               text          NOT NULL CHECK (change IN
                         ('added', 'removed', 'unchanged', 'moved', 'reshaped', 'attributes_changed', 'conflict')),
  code                 text,
  previous_code        text,
  distance_m           numeric(14, 3),
  length_delta_m       numeric(14, 3),
  candidate_feature_ids uuid[]       NOT NULL DEFAULT '{}',
  CONSTRAINT revision_diff_items_revision_fkey
    FOREIGN KEY (project_id, revision_id) REFERENCES design_revisions (project_id, id) ON DELETE CASCADE,
  CONSTRAINT revision_diff_items_feature_fkey
    FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id),
  CONSTRAINT revision_diff_items_feature_key UNIQUE (revision_id, feature_id)
);
CREATE INDEX revision_diff_items_change_idx ON revision_diff_items (revision_id, change);

-- ---------- immutability (rule 3: design revisions are immutable once published) ----------

CREATE FUNCTION design_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  OR NEW.base_revision_id IS DISTINCT FROM OLD.base_revision_id THEN
    RAISE EXCEPTION 'design revision inputs are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER design_revisions_immutable
  BEFORE UPDATE OR DELETE ON design_revisions FOR EACH ROW EXECUTE FUNCTION design_revisions_guard();

-- Children of a published/discarded revision cannot be inserted, changed or deleted.
CREATE FUNCTION design_revision_children_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rev_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
  rev_status text;
BEGIN
  SELECT status INTO rev_status FROM design_revisions WHERE id = rev_id;
  IF rev_status IN ('published', 'discarded') THEN
    RAISE EXCEPTION '% of design revision % is immutable (% rejected)', TG_TABLE_NAME, rev_id, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.revision_id IS DISTINCT FROM OLD.revision_id THEN
    RAISE EXCEPTION 'revision_id is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER design_features_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON design_features
  FOR EACH ROW EXECUTE FUNCTION design_revision_children_guard();
CREATE TRIGGER text_links_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON text_links
  FOR EACH ROW EXECUTE FUNCTION design_revision_children_guard();
CREATE TRIGGER revision_diff_items_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON revision_diff_items
  FOR EACH ROW EXECUTE FUNCTION design_revision_children_guard();

-- Feature identities never change; a feature can be deleted only while no revision uses it
-- (enforced by the foreign keys), i.e. when a draft that created it is rebuilt or discarded.
CREATE FUNCTION features_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'features are immutable (UPDATE rejected)' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER features_no_update BEFORE UPDATE ON features
  FOR EACH ROW EXECUTE FUNCTION features_reject_update();

-- Row triggers do not fire on TRUNCATE; block it on every design table (security review L5).
CREATE FUNCTION design_tables_reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable design data (TRUNCATE rejected)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER design_revisions_no_truncate BEFORE TRUNCATE ON design_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION design_tables_reject_truncate();
CREATE TRIGGER features_no_truncate BEFORE TRUNCATE ON features
  FOR EACH STATEMENT EXECUTE FUNCTION design_tables_reject_truncate();
CREATE TRIGGER design_features_no_truncate BEFORE TRUNCATE ON design_features
  FOR EACH STATEMENT EXECUTE FUNCTION design_tables_reject_truncate();
CREATE TRIGGER text_links_no_truncate BEFORE TRUNCATE ON text_links
  FOR EACH STATEMENT EXECUTE FUNCTION design_tables_reject_truncate();
CREATE TRIGGER revision_diff_items_no_truncate BEFORE TRUNCATE ON revision_diff_items
  FOR EACH STATEMENT EXECUTE FUNCTION design_tables_reject_truncate();

-- ---------- tiles (ADR-021): Martin reads ONLY through this function ----------

CREATE SCHEMA IF NOT EXISTS tiles;

-- MVT of one revision's network features. query_params: {"p": projectId, "r": revisionId, …}
-- (Martin passes the URL query string). Unknown, mismatched or unusable ids give an empty tile.
-- The signature in the URL is checked by the API through Caddy forward_auth before Martin is called.
CREATE FUNCTION tiles.design_features(z integer, x integer, y integer, query_params json)
  RETURNS bytea
  LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  p_id uuid;
  r_id uuid;
  srid integer;
  tile bytea;
BEGIN
  BEGIN
    p_id := (query_params ->> 'p')::uuid;
    r_id := (query_params ->> 'r')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN ''::bytea;
  END;
  SELECT crs_epsg INTO srid FROM design_revisions
   WHERE id = r_id AND project_id = p_id AND status IN ('draft', 'published');
  IF srid IS NULL THEN
    RETURN ''::bytea;
  END IF;
  SELECT ST_AsMVT(mvt, 'design_features', 4096, 'geom') INTO tile FROM (
    SELECT ST_AsMVTGeom(ST_Transform(f.geom, 3857), ST_TileEnvelope(z, x, y), 4096, 64, true) AS geom,
           f.feature_id::text AS id, f.feature_type AS type, f.code, f.layer
      FROM design_features f
     WHERE f.revision_id = r_id
       AND f.geom && ST_Transform(ST_TileEnvelope(z, x, y), srid)
  ) AS mvt WHERE mvt.geom IS NOT NULL;
  RETURN coalesce(tile, ''::bytea);
END;
$$;
COMMENT ON FUNCTION tiles.design_features(integer, integer, integer, json) IS
  'Martin function source (ADR-021). Requires ?p=<projectId>&r=<revisionId>; signature checked by the API.';

-- Read-only role used by Martin. It can only execute the tile function: no table privileges, no
-- auto-published tables. The login password is set at deploy time (ALTER ROLE … LOGIN PASSWORD).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ftth_tiles') THEN
    CREATE ROLE ftth_tiles NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION tiles.design_features(integer, integer, integer, json) FROM PUBLIC;
REVOKE ALL ON SCHEMA tiles FROM PUBLIC;
GRANT USAGE ON SCHEMA tiles TO ftth_tiles;
GRANT EXECUTE ON FUNCTION tiles.design_features(integer, integer, integer, json) TO ftth_tiles;
-- Martin lists schemas and functions through the catalogs; nothing else is granted.
ALTER ROLE ftth_tiles SET default_transaction_read_only = on;
