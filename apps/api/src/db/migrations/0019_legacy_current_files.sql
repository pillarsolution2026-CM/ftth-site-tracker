-- 0019: one current file per kind for files uploaded before ADR-040 (owner 2026-11-11).
-- 0018 put every existing file under the General without marking older ones, so a project could
-- list several "current" Generals. For each project and kind with more than one current file, the
-- file to keep is: the file of the open revision (queued, building or draft), else the file of
-- the latest revision, else the newest file. The others become older versions of it: they stay in
-- the system as history (revisions and events keep pointing at them) and are no longer listed.
-- Idempotent: it only touches project/kind pairs that still have more than one current file.

CREATE OR REPLACE FUNCTION cad_files_supersede_legacy() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  changed integer;
BEGIN
  WITH current_files AS (
    SELECT f.project_id, f.drawing_kind, f.id, f.created_at
    FROM cad_files f
    WHERE f.superseded_at IS NULL
  ),
  duplicated AS (
    SELECT project_id, drawing_kind
    FROM current_files
    GROUP BY project_id, drawing_kind
    HAVING count(*) > 1
  ),
  keep AS (
    SELECT DISTINCT ON (c.project_id, c.drawing_kind) c.project_id, c.drawing_kind, c.id
    FROM current_files c
    JOIN duplicated d USING (project_id, drawing_kind)
    LEFT JOIN LATERAL (
      SELECT bool_or(r.status IN ('queued', 'building', 'draft')) AS has_open,
             max(r.created_at) AS last_revision_at
      FROM design_revisions r
      WHERE r.project_id = c.project_id AND r.cad_file_id = c.id
    ) rev ON true
    ORDER BY c.project_id, c.drawing_kind,
             coalesce(rev.has_open, false) DESC,
             rev.last_revision_at DESC NULLS LAST,
             c.created_at DESC,
             c.id DESC
  )
  UPDATE cad_files f
  SET superseded_at = now(), superseded_by = k.id
  FROM keep k
  WHERE f.project_id = k.project_id
    AND f.drawing_kind = k.drawing_kind
    AND f.superseded_at IS NULL
    AND f.id <> k.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

SELECT cad_files_supersede_legacy();
