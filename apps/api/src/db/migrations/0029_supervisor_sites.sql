-- 0029: supervisors work by site (ADR-054, owner 2026-11-21, point 2-ج). A supervisor holds one or
-- more sites of the work order and sees and records only on them; a site may have several
-- supervisors. Zones are retired: the zones tables and assignments.zone_id stay but nothing reads
-- them, so an old zone-bearing supervisor assignment behaves like a plain supervisor assignment.

CREATE TABLE supervisor_sites (
  project_id uuid        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  site_id    uuid        NOT NULL,
  created_by uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, site_id),
  -- The site belongs to the project (work_order_sites has UNIQUE (project_id, id), 0025).
  CONSTRAINT supervisor_sites_site_fkey FOREIGN KEY (project_id, site_id)
    REFERENCES work_order_sites (project_id, id) ON DELETE CASCADE
);
CREATE INDEX supervisor_sites_project_site_idx ON supervisor_sites (project_id, site_id);
CREATE INDEX supervisor_sites_project_user_idx ON supervisor_sites (project_id, user_id);

-- Only a user holding a supervisor assignment in the project can hold sites in it.
CREATE FUNCTION supervisor_sites_require_supervisor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.user_id = NEW.user_id AND a.project_id = NEW.project_id AND a.role = 'supervisor'
  ) THEN
    RAISE EXCEPTION 'supervisor_sites: the user is not a supervisor of this project'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supervisor_sites_supervisor_guard
  BEFORE INSERT OR UPDATE OF user_id, project_id ON supervisor_sites
  FOR EACH ROW EXECUTE FUNCTION supervisor_sites_require_supervisor();

-- When his last supervisor assignment in the project goes (removed, or no longer a supervisor),
-- his sites in that project go with it.
CREATE FUNCTION assignments_drop_supervisor_sites() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.user_id = OLD.user_id AND a.project_id = OLD.project_id AND a.role = 'supervisor'
  ) THEN
    DELETE FROM supervisor_sites WHERE user_id = OLD.user_id AND project_id = OLD.project_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER assignments_supervisor_sites_cleanup
  AFTER DELETE OR UPDATE OF role, user_id, project_id ON assignments
  FOR EACH ROW EXECUTE FUNCTION assignments_drop_supervisor_sites();
