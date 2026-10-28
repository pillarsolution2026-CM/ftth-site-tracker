-- 0004 (ADR-016): work type on items, unit prices with 6 decimals, units up to 64 characters.
-- Widening only: no stored value changes.

-- Unit price numeric(18,4) -> numeric(20,6) keeps 14 integer digits. PostgreSQL cannot change the
-- type of a column used by a generated column, so `amount` is dropped and recreated; it is
-- recomputed from the stored quantity and price. Exact product scale = 4 + 6 = 10, integer
-- digits = 14 + 14 = 28, hence numeric(38,10): still never rounded (ADR-011).
ALTER TABLE work_order_items DROP COLUMN amount;
ALTER TABLE work_order_items ALTER COLUMN unit_price TYPE numeric(20, 6);
ALTER TABLE work_order_items
  ADD COLUMN amount numeric(38, 10) GENERATED ALWAYS AS (quantity * unit_price) STORED;

ALTER TABLE work_order_items DROP CONSTRAINT work_order_items_unit_check;
ALTER TABLE work_order_items
  ADD CONSTRAINT work_order_items_unit_check CHECK (btrim(unit) <> '' AND length(unit) <= 64);

-- Fixed list set by the owner: civil = مدني, installation = تركيبات, planning = تخطيط.
-- NULL only for items saved before this migration; the API requires it for new and edited items.
ALTER TABLE work_order_items
  ADD COLUMN work_type text CONSTRAINT work_order_items_work_type_check
    CHECK (work_type IN ('civil', 'installation', 'planning'));
-- Filtering and per-type totals (invoices, reports).
CREATE INDEX work_order_items_order_work_type_idx ON work_order_items (work_order_id, work_type);
