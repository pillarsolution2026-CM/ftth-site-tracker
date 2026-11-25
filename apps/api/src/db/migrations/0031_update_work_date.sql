-- ADR-057 (owner, 2026-11-25): every work update carries its work date — the day the work was
-- done, chosen by the supervisor (today or earlier), read in Africa/Cairo. The contractor price
-- follows it, and a contractor cannot be picked on a day before his registration on the work order.

ALTER TABLE execution_updates ADD COLUMN work_date date;

-- Existing updates keep the day they were saved on the phone (ADR-053 behaviour). The update guard
-- refuses any change but the review fields, so it is switched off for this one backfill only.
ALTER TABLE execution_updates DISABLE TRIGGER execution_updates_immutable;
UPDATE execution_updates SET work_date = (captured_at AT TIME ZONE 'Africa/Cairo')::date;
ALTER TABLE execution_updates ENABLE TRIGGER execution_updates_immutable;

ALTER TABLE execution_updates ALTER COLUMN work_date SET NOT NULL;

-- Backstop of the API check (CONTRACTOR_NOT_REGISTERED_ON_DATE): a work line of a contractor line
-- needs its registration date on or before the work date of its update.
CREATE FUNCTION execution_update_lines_registration_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  registered date;
  worked     date;
BEGIN
  IF NEW.contractor_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT r.registered_on INTO registered
    FROM contractor_lines cl
    JOIN contractor_registrations r ON r.id = cl.registration_id
    WHERE cl.project_id = NEW.project_id AND cl.id = NEW.contractor_line_id;
  SELECT u.work_date INTO worked
    FROM execution_updates u
    WHERE u.project_id = NEW.project_id AND u.id = NEW.update_id;
  IF registered IS NOT NULL AND worked IS NOT NULL AND registered > worked THEN
    RAISE EXCEPTION 'contractor not registered on the work date (contractor line %, registered %, work date %)',
      NEW.contractor_line_id, registered, worked USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER execution_update_lines_registration_check
  BEFORE INSERT ON execution_update_lines
  FOR EACH ROW EXECUTE FUNCTION execution_update_lines_registration_check();
