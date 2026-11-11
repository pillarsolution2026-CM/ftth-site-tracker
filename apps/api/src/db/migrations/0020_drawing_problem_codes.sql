-- 0020 Drawing problem codes of ADR-041 (reading the General and the Secondary by meaning).
--
-- A correction may name the problem place it answers (`problem_code`, context only). The list of
-- codes grows with DRAWING_PROBLEM_CODES in @ftth/shared; the Phase-1 codes stay. Only the CHECK
-- changes: correction rows are immutable facts and are not touched. Everything else ADR-041 adds
-- lives in existing jsonb columns (mapping rules, design_features.attrs.reading,
-- design_revisions.counts.reading, design_revisions.warnings).

ALTER TABLE cad_file_corrections DROP CONSTRAINT cad_file_corrections_problem_code_check;
ALTER TABLE cad_file_corrections ADD CONSTRAINT cad_file_corrections_problem_code_check
  CHECK (problem_code IN ('ROUTE_SPLIT', 'RING_LABEL_MISMATCH', 'WRONG_LAYER', 'LABEL_MISSING',
    'LABEL_TYPE_MISMATCH', 'LABEL_LENGTH_MISSING',
    'HANDHOLE_TYPE_MISSING', 'HANDHOLE_TYPE_UNKNOWN', 'HANDHOLE_NOT_DRAWN',
    'BOX_NUMBER_DUPLICATE', 'BOX_NOT_REACHED', 'CABINET_BOX_COUNT_MISMATCH',
    'CABINET_ZONE_MISSING', 'SPARE_CORES_MISMATCH', 'CABLE_SLACK_TOO_SHORT',
    'CABLE_SLACK_TOO_LONG'));
