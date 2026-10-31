-- 0008 Work-order lines come from the project's approved contract (Phase 2 step 2, ADR-028).
-- Owner rules: the price is the contract price; an item outside the contract and a quantity above
-- the contract are blocked; the quantity is reserved when the work order is saved; a contract item
-- appears at most once per work order; one work order per project; a draft contract gives nothing.

-- One work order per project (owner, 2026-10-31).
ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_one_per_project UNIQUE (project_id);

-- Link to the contract item. NULL only for lines saved before this migration.
ALTER TABLE work_order_items
  ADD COLUMN contract_id      uuid,
  ADD COLUMN contract_item_id uuid,
  ADD CONSTRAINT work_order_items_contract_link_both
    CHECK ((contract_id IS NULL) = (contract_item_id IS NULL)),
  ADD CONSTRAINT work_order_items_contract_item_fkey
    FOREIGN KEY (contract_id, contract_item_id)
    REFERENCES contract_items (contract_id, id) ON DELETE RESTRICT;

-- A contract item at most once per work order.
CREATE UNIQUE INDEX work_order_items_order_contract_item_key
  ON work_order_items (work_order_id, contract_item_id) WHERE contract_item_id IS NOT NULL;
-- Reservation sums per contract item.
CREATE INDEX work_order_items_contract_item_idx
  ON work_order_items (contract_item_id) WHERE contract_item_id IS NOT NULL;

-- Database guarantee of the owner rules for every insert and every update of a linked line.
-- The contract row is locked first, so concurrent writes on the same contract are serialised and
-- the reservation sum cannot be exceeded by two transactions at once.
CREATE FUNCTION work_order_items_check_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_contract uuid;
  contract_status  text;
  ci               contract_items%ROWTYPE;
  reserved         numeric;
BEGIN
  IF NEW.contract_item_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'a new work-order line must come from a contract item'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Lines saved before ADR-028 stay as they are.
    IF OLD.contract_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'the contract link of a line is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.contract_item_id IS DISTINCT FROM OLD.contract_item_id THEN
    RAISE EXCEPTION 'the contract link of a line is immutable' USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT contract_id INTO project_contract FROM projects WHERE id = NEW.project_id;
  IF project_contract IS DISTINCT FROM NEW.contract_id THEN
    RAISE EXCEPTION 'the contract item belongs to another contract' USING ERRCODE = 'check_violation';
  END IF;

  SELECT status INTO contract_status FROM contracts WHERE id = NEW.contract_id FOR UPDATE;
  IF contract_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'work-order lines need an approved contract' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO ci FROM contract_items WHERE id = NEW.contract_item_id;
  IF ci.kind <> 'item' THEN
    RAISE EXCEPTION 'a contract heading cannot be a work-order line' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.code IS DISTINCT FROM ci.code
     OR NEW.description IS DISTINCT FROM ci.description
     OR NEW.unit IS DISTINCT FROM ci.unit
     OR NEW.unit_price IS DISTINCT FROM ci.unit_price
     OR NEW.work_type IS DISTINCT FROM ci.work_type THEN
    RAISE EXCEPTION 'a work-order line must equal its contract item' USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(sum(quantity), 0) INTO reserved FROM work_order_items
    WHERE contract_item_id = NEW.contract_item_id AND id <> NEW.id;
  IF reserved + NEW.quantity > ci.quantity THEN
    RAISE EXCEPTION 'quantity above the contract quantity (contract %, reserved %, requested %)',
      ci.quantity, reserved, NEW.quantity USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER work_order_items_contract_check
  BEFORE INSERT OR UPDATE ON work_order_items
  FOR EACH ROW EXECUTE FUNCTION work_order_items_check_contract();
