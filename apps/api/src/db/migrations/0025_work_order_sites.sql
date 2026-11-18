-- 0025 The work order holds its central and its sites (ADR-049, owner 2026-11-18).
-- A site keeps its id when renamed, so drawings (ADR-049 part B) and certificates can point at it.
-- Every change of the list is recorded as one `work_order.sites_changed` event by the API.

ALTER TABLE work_orders
  ADD COLUMN central text,
  ADD CONSTRAINT work_orders_central_length CHECK (central IS NULL OR char_length(central) BETWEEN 1 AND 200);

CREATE TABLE work_order_sites (
  id            uuid PRIMARY KEY,
  project_id    uuid        NOT NULL,
  work_order_id uuid        NOT NULL,
  name          text        NOT NULL,
  -- Comparison key (shared siteKeyOf): spaces, case and Arabic letter forms folded.
  name_key      text        NOT NULL,
  position      integer     NOT NULL,
  created_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_order_sites_order_fkey FOREIGN KEY (project_id, work_order_id)
    REFERENCES work_orders (project_id, id) ON DELETE CASCADE,
  CONSTRAINT work_order_sites_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT work_order_sites_key_length CHECK (char_length(name_key) BETWEEN 1 AND 200),
  CONSTRAINT work_order_sites_position_positive CHECK (position >= 1),
  -- Deferred so a list that swaps two names can be saved in one transaction.
  CONSTRAINT work_order_sites_name_key UNIQUE (work_order_id, name_key) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT work_order_sites_project_id_id_key UNIQUE (project_id, id)
);
CREATE INDEX work_order_sites_order_idx ON work_order_sites (work_order_id, position);
