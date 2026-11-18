-- 0026: drawings belong to a site of the work order (ADR-049 part B, owner 2026-11-18).
-- A drawing (`site_drawings`) is a line of file versions of one kind in one site: every site has one
-- General and one or more Secondary drawings. The site is read THROUGH the drawing, so linking a
-- legacy drawing to a site never touches an immutable published revision. rev_no is per site
-- publication: every revision a site publishes together shares one number.

-- Drawings -----------------------------------------------------------------------------------------

CREATE TABLE site_drawings (
  id           uuid PRIMARY KEY,
  project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- NULL only for drawings from before sites that are not linked yet («بدون موقع»).
  site_id      uuid,
  drawing_kind text        NOT NULL,
  -- General 1; Secondary 1, 2, … per site. Withdrawn drawings keep their number.
  ordinal      integer     NOT NULL,
  withdrawn_at timestamptz,
  withdrawn_by uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_drawings_kind_check CHECK (drawing_kind IN ('general', 'secondary')),
  CONSTRAINT site_drawings_ordinal_check CHECK (ordinal >= 1 AND (drawing_kind <> 'general' OR ordinal = 1)),
  CONSTRAINT site_drawings_withdrawn_check CHECK (withdrawn_by IS NULL OR withdrawn_at IS NOT NULL),
  CONSTRAINT site_drawings_site_fkey FOREIGN KEY (project_id, site_id)
    REFERENCES work_order_sites (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT site_drawings_project_id_id_key UNIQUE (project_id, id),
  CONSTRAINT site_drawings_site_kind_ordinal_key UNIQUE (site_id, drawing_kind, ordinal)
);
-- One General per site (a withdrawn one makes room for a new one).
CREATE UNIQUE INDEX site_drawings_one_general_idx ON site_drawings (site_id)
  WHERE drawing_kind = 'general' AND withdrawn_at IS NULL;
CREATE INDEX site_drawings_site_idx ON site_drawings (site_id);
CREATE INDEX site_drawings_project_idx ON site_drawings (project_id);

CREATE FUNCTION site_drawings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'site_drawings rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.drawing_kind IS DISTINCT FROM OLD.drawing_kind
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal THEN
    RAISE EXCEPTION 'site_drawings: project, kind and number never change' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A legacy drawing is linked to a site once: NULL -> site.
  IF NEW.site_id IS DISTINCT FROM OLD.site_id AND OLD.site_id IS NOT NULL THEN
    RAISE EXCEPTION 'site_drawings: a drawing never moves to another site' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL
     AND (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'site_drawings: a withdrawn drawing stays withdrawn' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Only a drawing that was never published can be withdrawn.
  IF NEW.withdrawn_at IS NOT NULL AND OLD.withdrawn_at IS NULL
     AND EXISTS (SELECT 1 FROM design_revisions r
                 WHERE r.project_id = OLD.project_id AND r.drawing_id = OLD.id AND r.status = 'published') THEN
    RAISE EXCEPTION 'site_drawings: a published drawing cannot be withdrawn' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER site_drawings_immutable BEFORE UPDATE OR DELETE ON site_drawings
  FOR EACH ROW EXECUTE FUNCTION site_drawings_guard();

CREATE FUNCTION site_drawings_reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'site_drawings is design data (TRUNCATE rejected)' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER site_drawings_no_truncate BEFORE TRUNCATE ON site_drawings
  FOR EACH STATEMENT EXECUTE FUNCTION site_drawings_reject_truncate();

-- Files and revisions point at their drawing; backfilled below, then NOT NULL ----------------------

ALTER TABLE cad_files ADD COLUMN drawing_id uuid;
ALTER TABLE design_revisions ADD COLUMN drawing_id uuid;

-- Backfill (idempotent: only rows with drawing_id IS NULL) -----------------------------------------
-- A project with exactly ONE work order gets a new site named «number — title» (the number alone
-- without a title); one General drawing takes every General file of the project (current and
-- superseded) and one Secondary drawing every Secondary file. A project with no work order or with
-- several gets the same drawings with site_id NULL («بدون موقع»). Revisions get the drawing of
-- their file with design_revisions_immutable disabled for that one UPDATE; ids, rev_no, features and
-- tiles do not change, so devices and pending operations keep working.

-- One current file per kind first (0019 did it once; the unique index below needs it again).
SELECT cad_files_supersede_legacy();

CREATE FUNCTION pg_temp.site_name_key(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(regexp_replace(
    translate(regexp_replace(normalize(name, NFC), '[ً-ٰٟـ]', '', 'g'),
              'أإآةى', 'اااهي'),
    '\s+', ' ', 'g')))
$$;

DO $$
DECLARE
  p        record;
  wo       record;
  site     uuid;
  wanted   text;
  wanted_key text;
  kind     text;
  drawing  uuid;
BEGIN
  FOR p IN
    SELECT DISTINCT project_id FROM cad_files WHERE drawing_id IS NULL
  LOOP
    site := NULL;
    IF (SELECT count(*) FROM work_orders w WHERE w.project_id = p.project_id) = 1 THEN
      SELECT w.id, w.number, w.title INTO wo FROM work_orders w WHERE w.project_id = p.project_id;
      wanted := left(CASE WHEN wo.title IS NULL OR btrim(wo.title) = ''
                          THEN wo.number ELSE wo.number || ' — ' || wo.title END, 200);
      wanted_key := left(pg_temp.site_name_key(wanted), 200);
      SELECT s.id INTO site FROM work_order_sites s
        WHERE s.work_order_id = wo.id AND s.name_key = wanted_key;
      IF site IS NULL THEN
        site := gen_random_uuid();
        INSERT INTO work_order_sites (id, project_id, work_order_id, name, name_key, position)
        VALUES (site, p.project_id, wo.id, wanted, wanted_key,
                COALESCE((SELECT max(s.position) FROM work_order_sites s WHERE s.work_order_id = wo.id), 0) + 1);
      END IF;
    END IF;

    FOREACH kind IN ARRAY ARRAY['general', 'secondary'] LOOP
      IF EXISTS (SELECT 1 FROM cad_files f WHERE f.project_id = p.project_id
                 AND f.drawing_kind = kind AND f.drawing_id IS NULL) THEN
        -- Reuse the drawing of an earlier partial run for the same site and kind.
        drawing := NULL;
        IF site IS NOT NULL THEN
          SELECT d.id INTO drawing FROM site_drawings d
            WHERE d.site_id = site AND d.drawing_kind = kind AND d.ordinal = 1;
        END IF;
        IF drawing IS NULL THEN
          drawing := gen_random_uuid();
          INSERT INTO site_drawings (id, project_id, site_id, drawing_kind, ordinal)
          VALUES (drawing, p.project_id, site, kind, 1);
        END IF;
        UPDATE cad_files SET drawing_id = drawing
          WHERE project_id = p.project_id AND drawing_kind = kind AND drawing_id IS NULL;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- A project with no work order (or several) and files of one kind keeps ONE unassigned drawing per
-- kind; a project with no files has none. Revisions follow their file's drawing.
ALTER TABLE design_revisions DISABLE TRIGGER design_revisions_immutable;
UPDATE design_revisions r SET drawing_id = f.drawing_id
  FROM cad_files f
  WHERE r.project_id = f.project_id AND r.cad_file_id = f.id AND r.drawing_id IS NULL;
ALTER TABLE design_revisions ENABLE TRIGGER design_revisions_immutable;

ALTER TABLE cad_files ALTER COLUMN drawing_id SET NOT NULL;
ALTER TABLE design_revisions ALTER COLUMN drawing_id SET NOT NULL;
ALTER TABLE cad_files ADD CONSTRAINT cad_files_drawing_fkey
  FOREIGN KEY (project_id, drawing_id) REFERENCES site_drawings (project_id, id) ON DELETE RESTRICT;
ALTER TABLE design_revisions ADD CONSTRAINT design_revisions_drawing_fkey
  FOREIGN KEY (project_id, drawing_id) REFERENCES site_drawings (project_id, id) ON DELETE RESTRICT;
CREATE INDEX cad_files_drawing_idx ON cad_files (drawing_id, created_at);
CREATE INDEX design_revisions_drawing_idx ON design_revisions (drawing_id, status);

-- The current file of a drawing: one (safe after 0019 and the backfill) --------------------------
CREATE UNIQUE INDEX cad_files_one_current_idx ON cad_files (drawing_id) WHERE superseded_at IS NULL;

-- Files: the drawing is fixed at upload; the file kind is the drawing kind; supersede stays inside
-- one drawing (was: one kind).
CREATE OR REPLACE FUNCTION cad_files_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.drawing_kind IS DISTINCT FROM OLD.drawing_kind THEN
    RAISE EXCEPTION 'cad_files: the drawing kind never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.drawing_id IS DISTINCT FROM OLD.drawing_id THEN
    RAISE EXCEPTION 'cad_files: the drawing never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL
     AND (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
          OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by) THEN
    RAISE EXCEPTION 'cad_files: a superseded file stays superseded' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.superseded_by IS NOT NULL AND OLD.superseded_by IS NULL
     AND (SELECT drawing_id FROM cad_files
          WHERE project_id = NEW.project_id AND id = NEW.superseded_by) <> NEW.drawing_id THEN
    RAISE EXCEPTION 'cad_files: a file is superseded by a file of the same drawing only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION cad_files_kind_from_drawing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  drawing_kind_of text;
BEGIN
  SELECT drawing_kind INTO drawing_kind_of FROM site_drawings
    WHERE project_id = NEW.project_id AND id = NEW.drawing_id;
  IF drawing_kind_of IS NULL OR drawing_kind_of <> NEW.drawing_kind THEN
    RAISE EXCEPTION 'cad file kind % does not match its drawing kind %', NEW.drawing_kind, drawing_kind_of
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cad_files_kind_from_drawing BEFORE INSERT ON cad_files
  FOR EACH ROW EXECUTE FUNCTION cad_files_kind_from_drawing();

-- Revisions: the drawing follows the source file (set when omitted, refused when it differs) -------
CREATE OR REPLACE FUNCTION design_revisions_kind_from_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file_kind    text;
  file_drawing uuid;
BEGIN
  SELECT drawing_kind, drawing_id INTO file_kind, file_drawing FROM cad_files
    WHERE project_id = NEW.project_id AND id = NEW.cad_file_id;
  IF file_kind IS NULL OR file_kind <> NEW.drawing_kind THEN
    RAISE EXCEPTION 'design revision kind % does not match its CAD file kind %', NEW.drawing_kind, file_kind
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.drawing_id IS NULL THEN
    NEW.drawing_id := file_drawing;
  ELSIF NEW.drawing_id <> file_drawing THEN
    RAISE EXCEPTION 'design revision drawing does not match its CAD file drawing'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

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
  OR NEW.drawing_id      IS DISTINCT FROM OLD.drawing_id
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

-- One open revision per DRAWING (was per project and kind) ----------------------------------------
DROP INDEX design_revisions_one_open_idx;
CREATE UNIQUE INDEX design_revisions_one_open_idx ON design_revisions (drawing_id)
  WHERE status IN ('queued', 'building', 'draft');

-- rev_no is per site publication: unique per drawing (numbers of one drawing may skip) ------------
ALTER TABLE design_revisions DROP CONSTRAINT design_revisions_rev_no_key;
ALTER TABLE design_revisions
  ADD CONSTRAINT design_revisions_rev_no_key UNIQUE (drawing_id, rev_no);
