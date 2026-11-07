-- 0013 Subcontractors (المقاولين الباطن) and their prices, Phase 2 point 2-أ part 1, ADR-036.
-- Owner rules (2026-11-07): contractors are entered once in a shared list and registered on a work
-- order with a registration date and lines; a line is a work-order line; its price is at most the
-- contract price; over every contractor of the work order, Σ quantity per line ≤ work-order
-- quantity; a price changes only from a later date and is never overwritten.
-- (0012 is the drawing placement migration of PR #42; the runner applies files by name.)

CREATE TABLE contractors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text        NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  contact_name         text        NOT NULL CHECK (btrim(contact_name) <> '' AND length(contact_name) <= 200),
  contact_phone        text        NOT NULL CHECK (btrim(contact_phone) <> '' AND length(contact_phone) <= 32),
  commercial_register  text        CHECK (btrim(commercial_register) <> '' AND length(commercial_register) <= 64),
  tax_card             text        CHECK (btrim(tax_card) <> '' AND length(tax_card) <= 64),
  version              integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by           uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- One entry per contractor in the shared list (ASSUMPTION: name, ignoring case and outer spaces).
CREATE UNIQUE INDEX contractors_name_key ON contractors (lower(btrim(name)));
CREATE TRIGGER contractors_set_updated_at
  BEFORE UPDATE ON contractors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A contractor registered on the work order of a project.
CREATE TABLE contractor_registrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid        NOT NULL,
  work_order_id  uuid        NOT NULL,
  contractor_id  uuid        NOT NULL REFERENCES contractors (id) ON DELETE RESTRICT,
  registered_on  date        NOT NULL,
  created_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contractor_registrations_order_fkey
    FOREIGN KEY (project_id, work_order_id) REFERENCES work_orders (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT contractor_registrations_order_contractor_key UNIQUE (work_order_id, contractor_id),
  CONSTRAINT contractor_registrations_project_id_id_key UNIQUE (project_id, id)
);
CREATE INDEX contractor_registrations_project_idx ON contractor_registrations (project_id);
CREATE INDEX contractor_registrations_contractor_idx ON contractor_registrations (contractor_id);

CREATE FUNCTION contractor_registrations_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
     OR NEW.contractor_id IS DISTINCT FROM OLD.contractor_id
     OR NEW.registered_on IS DISTINCT FROM OLD.registered_on THEN
    RAISE EXCEPTION 'a contractor registration is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contractor_registrations_guard
  BEFORE UPDATE ON contractor_registrations
  FOR EACH ROW EXECUTE FUNCTION contractor_registrations_guard_update();

-- A work-order line given to a registered contractor.
CREATE TABLE contractor_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid           NOT NULL,
  registration_id    uuid           NOT NULL,
  work_order_item_id uuid           NOT NULL,
  quantity           numeric(18, 4) NOT NULL CHECK (quantity > 0),
  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT contractor_lines_registration_fkey
    FOREIGN KEY (project_id, registration_id)
    REFERENCES contractor_registrations (project_id, id) ON DELETE CASCADE,
  CONSTRAINT contractor_lines_item_fkey
    FOREIGN KEY (project_id, work_order_item_id)
    REFERENCES work_order_items (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT contractor_lines_registration_item_key UNIQUE (registration_id, work_order_item_id)
);
CREATE INDEX contractor_lines_item_idx ON contractor_lines (work_order_item_id);
CREATE TRIGGER contractor_lines_set_updated_at
  BEFORE UPDATE ON contractor_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The line belongs to the registration's work order, comes from the contract (ADR-028) and the
-- contractors of the work order never hold more than the work-order quantity. The work order row
-- is locked first, so concurrent writes on the same work order are serialised.
CREATE FUNCTION contractor_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reg_order   uuid;
  item_order  uuid;
  item_qty    numeric;
  item_link   uuid;
  reserved    numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.registration_id IS DISTINCT FROM OLD.registration_id
      OR NEW.work_order_item_id IS DISTINCT FROM OLD.work_order_item_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    RAISE EXCEPTION 'a contractor line keeps its registration and work-order line'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT work_order_id INTO reg_order FROM contractor_registrations WHERE id = NEW.registration_id;
  PERFORM 1 FROM work_orders WHERE id = reg_order FOR UPDATE;

  SELECT work_order_id, quantity, contract_item_id INTO item_order, item_qty, item_link
    FROM work_order_items WHERE id = NEW.work_order_item_id;
  IF item_order IS DISTINCT FROM reg_order THEN
    RAISE EXCEPTION 'the line is not a line of the registration''s work order'
      USING ERRCODE = 'check_violation';
  END IF;
  IF item_link IS NULL THEN
    RAISE EXCEPTION 'a work-order line saved before ADR-028 cannot be given to a contractor'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(sum(quantity), 0) INTO reserved FROM contractor_lines
    WHERE work_order_item_id = NEW.work_order_item_id AND id <> NEW.id;
  IF reserved + NEW.quantity > item_qty THEN
    RAISE EXCEPTION 'contractor quantity above the work-order quantity (work order %, reserved %, requested %)',
      item_qty, reserved, NEW.quantity USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contractor_lines_quantity_check
  BEFORE INSERT OR UPDATE ON contractor_lines
  FOR EACH ROW EXECUTE FUNCTION contractor_lines_check();

-- A work-order line never drops below what its contractors hold.
CREATE FUNCTION work_order_items_check_contractors() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held numeric;
BEGIN
  IF NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM work_orders WHERE id = NEW.work_order_id FOR UPDATE;
  SELECT COALESCE(sum(quantity), 0) INTO held FROM contractor_lines
    WHERE work_order_item_id = NEW.id;
  IF NEW.quantity < held THEN
    RAISE EXCEPTION 'work-order quantity below the contractors'' quantity (contractors %, requested %)',
      held, NEW.quantity USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER work_order_items_contractors_check
  BEFORE UPDATE OF quantity ON work_order_items
  FOR EACH ROW EXECUTE FUNCTION work_order_items_check_contractors();

-- Dated price history of a contractor line. Never updated; removed only with its line.
CREATE TABLE contractor_line_prices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_line_id  uuid           NOT NULL REFERENCES contractor_lines (id) ON DELETE CASCADE,
  effective_from      date           NOT NULL,
  unit_price          numeric(20, 6) NOT NULL CHECK (unit_price >= 0),
  created_by          uuid           REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT contractor_line_prices_line_date_key UNIQUE (contractor_line_id, effective_from)
);

-- The first price starts on the registration date; each next one strictly later (ASSUMPTION:
-- most restrictive reading, no back-dating before the latest price). Never above the contract
-- price, which is the work-order line's unit price (ADR-028).
CREATE FUNCTION contractor_line_prices_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  contract_price numeric;
  reg_date       date;
  latest         date;
BEGIN
  SELECT w.unit_price, r.registered_on INTO contract_price, reg_date
    FROM contractor_lines l
    JOIN work_order_items w ON w.id = l.work_order_item_id
    JOIN contractor_registrations r ON r.id = l.registration_id
    WHERE l.id = NEW.contractor_line_id
    FOR UPDATE OF l;
  IF NEW.unit_price > contract_price THEN
    RAISE EXCEPTION 'contractor price above the contract price (contract %, requested %)',
      contract_price, NEW.unit_price USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(effective_from) INTO latest FROM contractor_line_prices
    WHERE contractor_line_id = NEW.contractor_line_id;
  IF latest IS NULL AND NEW.effective_from <> reg_date THEN
    RAISE EXCEPTION 'the first price starts on the registration date (%)', reg_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF latest IS NOT NULL AND NEW.effective_from <= latest THEN
    RAISE EXCEPTION 'a new price must start after the latest price date (%)', latest
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contractor_line_prices_insert_check
  BEFORE INSERT ON contractor_line_prices
  FOR EACH ROW EXECUTE FUNCTION contractor_line_prices_check();

CREATE FUNCTION contractor_line_prices_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'contractor prices are kept as history' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'contractor prices are never changed; add a new dated price'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- A DELETE is allowed only as the cascade of its line being removed.
  IF EXISTS (SELECT 1 FROM contractor_lines WHERE id = OLD.contractor_line_id) THEN
    RAISE EXCEPTION 'contractor prices are kept as history' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER contractor_line_prices_append_only
  BEFORE UPDATE OR DELETE ON contractor_line_prices
  FOR EACH ROW EXECUTE FUNCTION contractor_line_prices_append_only();
CREATE TRIGGER contractor_line_prices_no_truncate
  BEFORE TRUNCATE ON contractor_line_prices
  FOR EACH STATEMENT EXECUTE FUNCTION contractor_line_prices_append_only();

-- Every contractor line has a price by the end of the transaction.
CREATE FUNCTION contractor_lines_require_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM contractor_lines WHERE id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM contractor_line_prices WHERE contractor_line_id = NEW.id) THEN
    RAISE EXCEPTION 'a contractor line needs a price' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER contractor_lines_price_required
  AFTER INSERT ON contractor_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contractor_lines_require_price();
