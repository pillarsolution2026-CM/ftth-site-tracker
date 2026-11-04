-- 0010 Reading cabinets, rings and shape-drawn items (ADR-032, ADR-033, ADR-034; issue #32).
--
-- New feature types `cabinet` and `ring` wherever a feature type is checked. Hatches are kept as
-- their outer boundary (closed) so a layer of hatched symbols can become point features. An
-- INSERT keeps its insertion point and gains the centre of what is drawn, which is the symbol's
-- position (ADR-032); NULL on files processed before this migration (the insertion point is used).

ALTER TABLE features DROP CONSTRAINT features_feature_type_check;
ALTER TABLE features ADD CONSTRAINT features_feature_type_check
  CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh', 'cabinet', 'ring'));

ALTER TABLE design_features DROP CONSTRAINT design_features_feature_type_check;
ALTER TABLE design_features ADD CONSTRAINT design_features_feature_type_check
  CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh', 'cabinet', 'ring'));

ALTER TABLE execution_updates DROP CONSTRAINT execution_updates_feature_type_check;
ALTER TABLE execution_updates ADD CONSTRAINT execution_updates_feature_type_check
  CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh', 'cabinet', 'ring'));

ALTER TABLE asbuilt_edits DROP CONSTRAINT asbuilt_edits_feature_type_check;
ALTER TABLE asbuilt_edits ADD CONSTRAINT asbuilt_edits_feature_type_check
  CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh', 'cabinet', 'ring'));

ALTER TABLE asbuilt_features DROP CONSTRAINT asbuilt_features_feature_type_check;
ALTER TABLE asbuilt_features ADD CONSTRAINT asbuilt_features_feature_type_check
  CHECK (feature_type IN ('route', 'box', 'hhi', 'joint', 'mh', 'cabinet', 'ring'));

ALTER TABLE cad_curves DROP CONSTRAINT cad_curves_entity_type_check;
ALTER TABLE cad_curves ADD CONSTRAINT cad_curves_entity_type_check
  CHECK (entity_type IN ('LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC', 'CIRCLE', 'SPLINE', 'HATCH'));

ALTER TABLE cad_inserts ADD COLUMN centre geometry(PointZ, 0);
