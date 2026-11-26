-- 0030: supervisor picks the BOQ line by element -> main group -> sub group; digging L x W x D;
-- the «التخطيط» button (ADR-056, owner 2026-11-25, point 2-ب).
--
-- 1. element_group_map: ONE system-level map (not per contract) from an element the supervisor can
--    open to the ADR-048 main group names offered under it. Seeded with the owner's map; the admin
--    replaces an element's list (version + 1, event element_groups.changed). The map only guides the
--    device: nothing here refuses a line because of it.
-- 2. execution_update_lines: length / width / depth of a digging m3 line (all three or none).
-- 3. execution_updates: a «التخطيط» update has no element: feature_id (and feature_type) become
--    NULL and drawing_id says which drawing it was recorded on. Exactly one of the two is set.

CREATE TABLE element_group_map (
  element    text        PRIMARY KEY
    CHECK (element IN ('route_general', 'route_secondary', 'cabinet', 'box', 'room', 'joint', 'planning')),
  -- Main group names in display order.
  mains      text[]      NOT NULL,
  version    integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid        REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO element_group_map (element, mains) VALUES
  ('route_general', ARRAY[
    'حفر', 'بنادل', 'طبقة خرسانية', 'كونيكتور', 'طبات', 'تخطيات', 'عدايات', 'مواسير', 'SUBDUCT',
    'كابلات ألياف ضوئية', 'أعمال الدفع الهوائي', 'مانع تسريب', 'طبقة إحلال', 'H.C', 'كابلات نحاس']),
  ('route_secondary', ARRAY[
    'حفر', 'بنادل', 'طبقة خرسانية', 'كونيكتور', 'طبات', 'تخطيات', 'عدايات', 'مواسير', 'SUBDUCT',
    'كابلات ألياف ضوئية', 'أعمال الدفع الهوائي', 'مانع تسريب', 'طبقة إحلال', 'H.C']),
  ('cabinet', ARRAY['قاعدة كابينة', 'كابينه', 'ODF', 'مقسم اشارة', 'RACK']),
  ('box', ARRAY['BOX', 'أعمال الدفع الهوائي', 'مقسم اشارة']),
  ('room', ARRAY['غرف', 'لحام في الغرف']),
  ('joint', ARRAY['لحام في الغرف']),
  ('planning', ARRAY['As Built', 'GIS', 'AS PLAN']);

-- Digging dimensions, metres. A line typed with them has quantity = L x W x D (checked by the API).
ALTER TABLE execution_update_lines
  ADD COLUMN length_m numeric(18, 4),
  ADD COLUMN width_m  numeric(18, 4),
  ADD COLUMN depth_m  numeric(18, 4),
  ADD CONSTRAINT execution_update_lines_dimensions_all_or_none CHECK (
    (length_m IS NULL AND width_m IS NULL AND depth_m IS NULL)
    OR (length_m IS NOT NULL AND width_m IS NOT NULL AND depth_m IS NOT NULL
        AND length_m > 0 AND width_m > 0 AND depth_m > 0 AND role = 'work'));

-- «التخطيط»: an update on a drawing, not on an element.
ALTER TABLE execution_updates
  ALTER COLUMN feature_id DROP NOT NULL,
  ALTER COLUMN feature_type DROP NOT NULL,
  ADD COLUMN drawing_id uuid,
  ADD CONSTRAINT execution_updates_drawing_fkey
    FOREIGN KEY (project_id, drawing_id) REFERENCES site_drawings (project_id, id),
  ADD CONSTRAINT execution_updates_element_or_drawing CHECK (
    (feature_id IS NOT NULL AND feature_type IS NOT NULL AND drawing_id IS NULL)
    OR (feature_id IS NULL AND feature_type IS NULL AND drawing_id IS NOT NULL));
CREATE INDEX execution_updates_drawing_idx ON execution_updates (project_id, drawing_id)
  WHERE drawing_id IS NOT NULL;
