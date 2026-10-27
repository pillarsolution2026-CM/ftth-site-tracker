-- 0002: an assignment's zone must belong to the assignment's own project.
ALTER TABLE zones ADD CONSTRAINT zones_project_id_id_key UNIQUE (project_id, id);

ALTER TABLE assignments DROP CONSTRAINT assignments_zone_id_fkey;
-- MATCH SIMPLE: rows with zone_id NULL (project-wide) are not checked.
ALTER TABLE assignments
  ADD CONSTRAINT assignments_project_zone_fkey
  FOREIGN KEY (project_id, zone_id) REFERENCES zones (project_id, id) ON DELETE CASCADE;
