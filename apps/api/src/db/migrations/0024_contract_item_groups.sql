-- 0024 Contract item groups (ADR-048).
--
-- The groups of a BOQ line are a system rule computed when read (packages/shared item-groups.ts).
-- Only the admin's manual choices are stored here: append-only, the latest row per item is in force,
-- and a row with main_group NULL means "back to the rule". No backfill: existing contracts get their
-- groups from the rule.

CREATE TABLE contract_item_group_choices (
  id               uuid PRIMARY KEY,
  contract_id      uuid        NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  contract_item_id uuid        NOT NULL REFERENCES contract_items (id) ON DELETE CASCADE,
  main_group       text,
  sub_group        text,
  chosen_by        uuid        REFERENCES users (id),
  chosen_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_item_group_choices_sub_needs_main CHECK (sub_group IS NULL OR main_group IS NOT NULL),
  CONSTRAINT contract_item_group_choices_main_length CHECK (main_group IS NULL OR char_length(main_group) BETWEEN 1 AND 80),
  CONSTRAINT contract_item_group_choices_sub_length CHECK (sub_group IS NULL OR char_length(sub_group) BETWEEN 1 AND 80)
);
CREATE INDEX contract_item_group_choices_item_idx
  ON contract_item_group_choices (contract_item_id, chosen_at DESC);
CREATE INDEX contract_item_group_choices_contract_idx
  ON contract_item_group_choices (contract_id);

-- Append-only. A row may go only together with its contract item (or contract): the foreign-key
-- cascade runs after the parent row is gone, so a direct DELETE (parent still there) is refused
-- while the cascade of a draft contract's line removal or contract deletion still works.
CREATE FUNCTION contract_item_group_choices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND (NOT EXISTS (SELECT 1 FROM contract_items WHERE id = OLD.contract_item_id)
          OR NOT EXISTS (SELECT 1 FROM contracts WHERE id = OLD.contract_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'contract_item_group_choices is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER contract_item_group_choices_append_only
  BEFORE UPDATE OR DELETE ON contract_item_group_choices
  FOR EACH ROW EXECUTE FUNCTION contract_item_group_choices_guard();
CREATE TRIGGER contract_item_group_choices_no_truncate
  BEFORE TRUNCATE ON contract_item_group_choices
  FOR EACH STATEMENT EXECUTE FUNCTION execution_reject_mutation();
