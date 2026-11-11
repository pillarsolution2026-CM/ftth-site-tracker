-- 0021 Problem codes from the owner's answers to the ADR-041 questions (2026-11-11): a box naming a
-- cabinet that is not in the drawing, two cabinets with the same name, a 1way with no duct size.
-- Only the CHECK on the correction context changes (DRAWING_PROBLEM_CODES in @ftth/shared).

ALTER TABLE cad_file_corrections DROP CONSTRAINT cad_file_corrections_problem_code_check;
ALTER TABLE cad_file_corrections ADD CONSTRAINT cad_file_corrections_problem_code_check
  CHECK (problem_code IN ('ROUTE_SPLIT', 'RING_LABEL_MISMATCH', 'WRONG_LAYER', 'LABEL_MISSING',
    'LABEL_TYPE_MISMATCH', 'LABEL_LENGTH_MISSING',
    'HANDHOLE_TYPE_MISSING', 'HANDHOLE_TYPE_UNKNOWN', 'HANDHOLE_NOT_DRAWN',
    'BOX_NUMBER_DUPLICATE', 'BOX_NOT_REACHED', 'CABINET_BOX_COUNT_MISMATCH',
    'CABINET_ZONE_MISSING', 'SPARE_CORES_MISMATCH', 'CABLE_SLACK_TOO_SHORT',
    'CABLE_SLACK_TOO_LONG', 'BOX_CABINET_UNKNOWN', 'CABINET_NAME_DUPLICATE',
    'CONNECTOR_SIZE_MISSING'));
