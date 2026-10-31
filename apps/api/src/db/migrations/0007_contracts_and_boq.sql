-- 0007 Contracts (العقد) and their BOQ (المقايسة), Phase 2, ADR-027.
-- A contract sits above projects; each project is one work order (أمر التكليف / المشروع) under a
-- contract. Contracts are not project-scoped: only platform admins write them.

CREATE TABLE contracts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text        NOT NULL CHECK (btrim(number) <> '' AND length(number) <= 64),
  name           text        NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  client         text        NOT NULL CHECK (btrim(client) <> '' AND length(client) <= 200),
  -- Fixed at creation; projects and work orders copy it.
  currency       char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  starts_on      date,
  duration_days  integer     CHECK (duration_days BETWEEN 1 AND 36500),
  notes          text        CHECK (length(notes) <= 4000),
  status         text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  approved_at    timestamptz,
  approved_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
  -- Optimistic concurrency; bumped by the repository on every header or BOQ change.
  version        integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contracts_number_key UNIQUE (number),
  CONSTRAINT contracts_approval_check CHECK ((status = 'approved') = (approved_at IS NOT NULL))
);
CREATE TRIGGER contracts_set_updated_at
  BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Currency never changes; approval is final.
CREATE FUNCTION contracts_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'contracts.currency is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'approved' AND (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'an approved contract stays approved' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contracts_guard
  BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION contracts_guard_update();

CREATE TABLE contract_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  uuid           NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  line_no      integer        NOT NULL CHECK (line_no >= 1),
  kind         text           NOT NULL CHECK (kind IN ('item', 'heading')),
  code         text           NOT NULL CHECK (btrim(code) <> '' AND length(code) <= 64),
  -- NULL only for a heading without a title.
  description  text           CHECK (btrim(description) <> '' AND length(description) <= 2000),
  unit         text           CHECK (btrim(unit) <> '' AND length(unit) <= 64),
  -- Contract quantity (كمية التعاقد); 0 is allowed (owner, 2026-10-31).
  quantity     numeric(18, 4) CHECK (quantity >= 0),
  unit_price   numeric(20, 6) CHECK (unit_price >= 0),
  -- Exact product, never rounded (same scale as work_order_items, ADR-016).
  amount       numeric(38, 10) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  work_type    text           CHECK (work_type IN ('civil', 'installation', 'planning')),
  source       text           NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
  source_row   integer        CHECK (source_row >= 1),
  created_at   timestamptz    NOT NULL DEFAULT now(),
  updated_at   timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT contract_items_kind_fields CHECK (
    (kind = 'item' AND description IS NOT NULL AND unit IS NOT NULL AND quantity IS NOT NULL
       AND unit_price IS NOT NULL AND work_type IS NOT NULL)
    OR
    (kind = 'heading' AND unit IS NULL AND quantity IS NULL AND unit_price IS NULL
       AND work_type IS NULL)),
  CONSTRAINT contract_items_line_no_key UNIQUE (contract_id, line_no) DEFERRABLE INITIALLY IMMEDIATE,
  -- Target of work_order_items.contract_item_id (next step): an item of this contract.
  CONSTRAINT contract_items_contract_id_id_key UNIQUE (contract_id, id)
);
-- Duplicate codes need an explicit user decision (checked by the application), as in work orders.
CREATE INDEX contract_items_contract_code_idx ON contract_items (contract_id, code);
CREATE TRIGGER contract_items_set_updated_at
  BEFORE UPDATE ON contract_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The BOQ of an approved contract is locked (owner): no line may be added, changed or removed.
-- Lines of a contract being deleted (draft only, see below) cascade without this check.
CREATE FUNCTION contract_items_reject_when_approved() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  contract_status text;
BEGIN
  SELECT status INTO contract_status FROM contracts
    WHERE id = COALESCE(NEW.contract_id, OLD.contract_id);
  IF contract_status = 'approved' THEN
    RAISE EXCEPTION 'the BOQ of an approved contract is locked' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.contract_id IS DISTINCT FROM OLD.contract_id THEN
    RAISE EXCEPTION 'contract_items.contract_id is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER contract_items_lock
  BEFORE INSERT OR UPDATE OR DELETE ON contract_items
  FOR EACH ROW EXECUTE FUNCTION contract_items_reject_when_approved();

-- An approved contract cannot be deleted (its lines are locked and projects may use it).
CREATE FUNCTION contracts_reject_delete_when_approved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'an approved contract cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER contracts_no_delete_when_approved
  BEFORE DELETE ON contracts FOR EACH ROW EXECUTE FUNCTION contracts_reject_delete_when_approved();

CREATE TABLE contract_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   uuid        NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  kind          text        NOT NULL CHECK (kind IN ('document', 'import_source')),
  file_name     text        NOT NULL CHECK (btrim(file_name) <> '' AND length(file_name) <= 255),
  content_type  text        NOT NULL CHECK (content_type IN (
                  'application/pdf',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  size_bytes    bigint      NOT NULL CHECK (size_bytes > 0),
  sha256        char(64)    NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key   text        NOT NULL UNIQUE,
  uploaded_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_attachments_kind_type CHECK (
    (kind = 'document' AND content_type = 'application/pdf') OR
    (kind = 'import_source' AND content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
);
CREATE INDEX contract_attachments_contract_idx ON contract_attachments (contract_id, created_at);

-- A project (= one work order) belongs to one contract. NULL only for projects created before
-- Phase 2. The project's currency must equal the contract's (checked below).
ALTER TABLE projects
  ADD COLUMN contract_id uuid REFERENCES contracts (id) ON DELETE RESTRICT;
CREATE INDEX projects_contract_idx ON projects (contract_id);

CREATE FUNCTION projects_guard_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  contract_currency char(3);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.contract_id IS NOT NULL
      AND NEW.contract_id IS DISTINCT FROM OLD.contract_id THEN
    RAISE EXCEPTION 'projects.contract_id is immutable once set' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.contract_id IS NOT NULL THEN
    SELECT currency INTO contract_currency FROM contracts WHERE id = NEW.contract_id;
    IF contract_currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'project currency must equal the contract currency'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_contract_guard
  BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION projects_guard_contract();
