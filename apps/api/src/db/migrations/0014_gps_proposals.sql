-- 0014 Supervisor GPS point proposals (ADR-035, ADR-037).
--
-- A supervisor at a point item of the published drawing sends the phone's fix through the Phase 3
-- sync path (`sync_operations`, same idempotency). A PM accepts it (the API adds a `gps` control
-- point to the mapping of `cad_file_id`, a new mapping version) or rejects it. A proposal is a
-- fact: the only change ever allowed is the one decision pending -> accepted | rejected.

ALTER TABLE sync_operations DROP CONSTRAINT sync_operations_kind_check;
ALTER TABLE sync_operations ADD CONSTRAINT sync_operations_kind_check
  CHECK (kind IN ('execution_update.record', 'asbuilt_edit.record', 'placement_point.propose'));

CREATE TABLE gps_point_proposals (
  id                       uuid PRIMARY KEY,           -- the id returned in the op result
  project_id               uuid          NOT NULL REFERENCES projects (id),
  client_op_id             uuid          NOT NULL UNIQUE REFERENCES sync_operations (client_op_id),
  design_revision_id       uuid          NOT NULL,
  feature_id               uuid          NOT NULL,
  -- The file the revision was built from and the item's drawing handle in it, copied at receipt.
  cad_file_id              uuid          NOT NULL,
  handle                   text          NOT NULL CHECK (length(handle) BETWEEN 1 AND 64),
  feature_type             text          NOT NULL
                             CHECK (feature_type IN ('cabinet', 'hhi', 'mh', 'joint', 'box')),
  code                     text          CHECK (length(code) <= 200),
  fix                      geometry(Point, 4326) NOT NULL,
  accuracy_m               double precision NOT NULL CHECK (accuracy_m >= 0 AND accuracy_m <= 5),
  fix_at                   timestamptz   NOT NULL,     -- device clock (evidence only)
  received_at              timestamptz   NOT NULL DEFAULT now(),
  proposed_by              uuid          NOT NULL REFERENCES users (id),
  device_id                uuid          NOT NULL,
  note                     text          CHECK (length(note) <= 500),
  status                   text          NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_by               uuid          REFERENCES users (id),
  decided_at               timestamptz,
  reject_reason            text          CHECK (length(reject_reason) BETWEEN 1 AND 500),
  accepted_mapping_version integer       CHECK (accepted_mapping_version >= 1),
  CONSTRAINT gps_point_proposals_project_id_id_key UNIQUE (project_id, id),
  CONSTRAINT gps_point_proposals_revision_fkey
    FOREIGN KEY (project_id, design_revision_id) REFERENCES design_revisions (project_id, id),
  CONSTRAINT gps_point_proposals_feature_fkey
    FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id),
  CONSTRAINT gps_point_proposals_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id),
  CONSTRAINT gps_point_proposals_decision_complete CHECK (
    (status = 'pending') = (decided_at IS NULL) AND
    (status = 'pending') = (decided_by IS NULL) AND
    (status = 'accepted') = (accepted_mapping_version IS NOT NULL) AND
    (status = 'rejected') = (reject_reason IS NOT NULL))
);
CREATE INDEX gps_point_proposals_project_idx ON gps_point_proposals (project_id, received_at DESC);
CREATE INDEX gps_point_proposals_file_idx ON gps_point_proposals (project_id, cad_file_id, status);

-- Photos belong to an update or to a proposal (exactly one).
ALTER TABLE execution_photos ALTER COLUMN update_id DROP NOT NULL;
ALTER TABLE execution_photos ADD COLUMN proposal_id uuid;
ALTER TABLE execution_photos ADD CONSTRAINT execution_photos_proposal_fkey
  FOREIGN KEY (project_id, proposal_id) REFERENCES gps_point_proposals (project_id, id);
ALTER TABLE execution_photos ADD CONSTRAINT execution_photos_owner_one CHECK (
  num_nonnulls(update_id, proposal_id) = 1);
CREATE INDEX execution_photos_proposal_idx ON execution_photos (proposal_id)
  WHERE proposal_id IS NOT NULL;

-- Immutability -----------------------------------------------------------------------------------

CREATE TRIGGER gps_point_proposals_no_delete BEFORE DELETE ON gps_point_proposals
  FOR EACH ROW EXECUTE FUNCTION execution_reject_mutation();
CREATE TRIGGER gps_point_proposals_no_truncate BEFORE TRUNCATE ON gps_point_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();

-- pending -> accepted | rejected, once; every other column is fixed.
CREATE FUNCTION gps_point_proposals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'gps_point_proposals: a decided proposal is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'accepted_mapping_version'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'accepted_mapping_version']) THEN
    RAISE EXCEPTION 'gps_point_proposals: only the decision fields may change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'gps_point_proposals: a pending proposal can only be accepted or rejected' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gps_point_proposals_immutable BEFORE UPDATE ON gps_point_proposals
  FOR EACH ROW EXECUTE FUNCTION gps_point_proposals_guard();
