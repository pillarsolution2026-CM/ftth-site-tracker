-- 0001 Foundation: identity, projects, zones, assignments, append-only events.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  display_name  text        NOT NULL,
  password_hash text        NOT NULL,
  locale        text        NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en', 'fr')),
  is_admin      boolean     NOT NULL DEFAULT false,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Emails are stored lower-cased by the application; the constraint makes that a database guarantee.
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid        NOT NULL,
  token_hash  text        NOT NULL UNIQUE,   -- SHA-256 hex of the opaque token; the token itself is never stored
  expires_at  timestamptz NOT NULL,
  rotated_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  client     text        NOT NULL,
  crs_epsg   integer     NOT NULL,           -- project CRS (metric); geometry is stored in it
  currency   char(3)     NOT NULL,
  locale     text        NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en', 'fr')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE zones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  parent_id  uuid        REFERENCES zones (id) ON DELETE SET NULL,
  name       text        NOT NULL,
  geom       geometry(MultiPolygon),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The SRID of zones.geom equals projects.crs_epsg of the owning project (enforced by the repository on write).
COMMENT ON COLUMN zones.geom IS 'MultiPolygon in the project CRS: ST_SRID(geom) = projects.crs_epsg';
CREATE INDEX zones_project_idx ON zones (project_id);
CREATE INDEX zones_geom_gix ON zones USING gist (geom);

CREATE TABLE assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('admin', 'pm', 'supervisor', 'qc', 'contractor')),
  zone_id       uuid REFERENCES zones (id) ON DELETE CASCADE,
  contractor_id uuid,                        -- contractors table arrives with the contract module
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignments_unique UNIQUE NULLS NOT DISTINCT (user_id, project_id, role, zone_id, contractor_id)
);
CREATE INDEX assignments_user_idx ON assignments (user_id);
CREATE INDEX assignments_project_idx ON assignments (project_id);

CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  project_id uuid        REFERENCES projects (id),
  entity     text        NOT NULL,
  entity_id  text        NOT NULL,
  type       text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  actor_id   uuid        REFERENCES users (id),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_entity_idx ON events (entity, entity_id);
CREATE INDEX events_project_idx ON events (project_id, at);

-- Every change is an immutable event: reject UPDATE and DELETE.
CREATE FUNCTION events_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only (% rejected)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER events_no_update_delete
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_reject_mutation();
-- TRUNCATE is not a row operation; block it as well.
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_reject_mutation();
