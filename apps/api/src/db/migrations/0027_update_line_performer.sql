-- 0027 Who performed each work line of an execution update, ADR-052 (subcontractors part 2).
-- Owner rules (2026-11-21): every work line carries its performer: a contractor line (contractor
-- + scope, registered on THAT work-order line of THIS project) or `self` (own crew, no cap).
-- Material lines carry none. One work-order line may repeat in an update, once per performer.
-- A contractor line takes work only up to its quantity: pending + approved work counts, rejected
-- work does not. The API checks this first (and answers a rejection code); the triggers below are
-- the backstop. Lines recorded before this migration are trial data and stay without a performer.

ALTER TABLE contractor_lines
  ADD CONSTRAINT contractor_lines_project_id_id_key UNIQUE (project_id, id);

ALTER TABLE execution_update_lines
  ADD COLUMN performer text,
  ADD COLUMN contractor_line_id uuid;

ALTER TABLE execution_update_lines
  ADD CONSTRAINT execution_update_lines_performer_check
    CHECK (performer IN ('contractor', 'self')),
  -- A material line is recorded on the update's work as a whole.
  ADD CONSTRAINT execution_update_lines_material_no_performer
    CHECK (role <> 'material' OR (performer IS NULL AND contractor_line_id IS NULL)),
  ADD CONSTRAINT execution_update_lines_performer_line
    CHECK ((performer = 'contractor') = (contractor_line_id IS NOT NULL)),
  -- NOT VALID on purpose: work lines recorded before ADR-052 (trial data) have no performer and
  -- are kept as they are; every NEW row is still checked.
  ADD CONSTRAINT execution_update_lines_work_needs_performer
    CHECK (role <> 'work' OR performer IS NOT NULL) NOT VALID,
  -- A contractor line cannot be removed once work was recorded on it (the API answers 409).
  ADD CONSTRAINT execution_update_lines_contractor_line_fkey
    FOREIGN KEY (project_id, contractor_line_id)
    REFERENCES contractor_lines (project_id, id) ON DELETE RESTRICT;

CREATE INDEX execution_update_lines_contractor_line_idx
  ON execution_update_lines (contractor_line_id) WHERE contractor_line_id IS NOT NULL;

-- Once per performer inside one update (the old key allowed one line per work-order line).
ALTER TABLE execution_update_lines DROP CONSTRAINT execution_update_lines_item_key;
CREATE UNIQUE INDEX execution_update_lines_item_key
  ON execution_update_lines (
    update_id, role, work_order_item_id, COALESCE(performer, ''),
    COALESCE(contractor_line_id, '00000000-0000-0000-0000-000000000000'));

-- The contractor line must be a line of the same work-order line, and has room for the quantity.
-- The contractor line row is locked first, so concurrent writers on it are serialised. Lines of
-- the same update inserted earlier count (they are already visible in the transaction).
CREATE FUNCTION execution_update_lines_contractor_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_item  uuid;
  line_qty   numeric;
  recorded   numeric;
BEGIN
  IF NEW.contractor_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT work_order_item_id, quantity INTO line_item, line_qty
    FROM contractor_lines
    WHERE project_id = NEW.project_id AND id = NEW.contractor_line_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;  -- the foreign key reports it
  END IF;
  IF line_item IS DISTINCT FROM NEW.work_order_item_id THEN
    RAISE EXCEPTION 'the contractor line belongs to another work-order line'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(l.quantity), 0) INTO recorded
    FROM execution_update_lines l
    JOIN execution_updates u ON u.project_id = l.project_id AND u.id = l.update_id
    WHERE l.contractor_line_id = NEW.contractor_line_id AND u.status <> 'rejected';
  IF recorded + NEW.quantity > line_qty THEN
    RAISE EXCEPTION 'contractor quantity exceeded (contractor line %, quantity %, recorded %, requested %)',
      NEW.contractor_line_id, line_qty, recorded, NEW.quantity USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER execution_update_lines_contractor_check
  BEFORE INSERT ON execution_update_lines
  FOR EACH ROW EXECUTE FUNCTION execution_update_lines_contractor_check();

-- The admin cannot lower a contractor line under its pending + approved recorded work.
CREATE FUNCTION contractor_lines_check_recorded() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  recorded numeric;
BEGIN
  IF NEW.quantity >= OLD.quantity THEN
    RETURN NEW;
  END IF;
  -- The UPDATE holds the row lock, so a concurrent insert of work waits for this transaction.
  SELECT COALESCE(sum(l.quantity), 0) INTO recorded
    FROM execution_update_lines l
    JOIN execution_updates u ON u.project_id = l.project_id AND u.id = l.update_id
    WHERE l.contractor_line_id = NEW.id AND u.status <> 'rejected';
  IF NEW.quantity < recorded THEN
    RAISE EXCEPTION 'contractor quantity below the recorded work (contractor line %, recorded %, requested %)',
      NEW.id, recorded, NEW.quantity USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contractor_lines_recorded_check
  BEFORE UPDATE OF quantity ON contractor_lines
  FOR EACH ROW EXECUTE FUNCTION contractor_lines_check_recorded();
