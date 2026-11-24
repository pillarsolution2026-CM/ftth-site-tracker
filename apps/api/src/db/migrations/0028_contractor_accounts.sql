-- 0028 Read-only login accounts of subcontractors, ADR-053 (subcontractors part 3).
-- Owner rules (2026-11-21): an account is a user linked to ONE contractor of the shared list (several
-- accounts per company). It holds no project role and is never an admin: both are refused here
-- (the API answers first; these triggers are the backstop and also cover the CLI and SQL).

CREATE TABLE contractor_accounts (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  contractor_id  uuid        NOT NULL REFERENCES contractors (id) ON DELETE RESTRICT,
  created_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contractor_accounts_contractor_idx ON contractor_accounts (contractor_id);

-- A user becoming a contractor account: not an admin, no assignment. The user row is locked so a
-- concurrent assignment (which takes a share lock below) or admin promotion cannot slip between.
CREATE FUNCTION contractor_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_is_admin boolean;
BEGIN
  SELECT is_admin INTO user_is_admin FROM users WHERE id = NEW.user_id FOR UPDATE;
  IF user_is_admin THEN
    RAISE EXCEPTION 'a contractor account cannot be an admin' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM assignments WHERE user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'a contractor account cannot hold a project assignment'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contractor_accounts_guard
  BEFORE INSERT OR UPDATE OF user_id ON contractor_accounts
  FOR EACH ROW EXECUTE FUNCTION contractor_accounts_guard();

-- A user that is a contractor account never gets an assignment.
CREATE FUNCTION assignments_refuse_contractor_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users WHERE id = NEW.user_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM contractor_accounts WHERE user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'a contractor account cannot hold a project assignment'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assignments_contractor_account_guard
  BEFORE INSERT OR UPDATE OF user_id ON assignments
  FOR EACH ROW EXECUTE FUNCTION assignments_refuse_contractor_account();

-- A user that is a contractor account is never made an admin.
CREATE FUNCTION users_refuse_contractor_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM contractor_accounts WHERE user_id = NEW.id) THEN
    RAISE EXCEPTION 'a contractor account cannot be an admin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_contractor_admin_guard
  BEFORE UPDATE OF is_admin ON users
  FOR EACH ROW WHEN (NEW.is_admin AND NOT OLD.is_admin)
  EXECUTE FUNCTION users_refuse_contractor_admin();
