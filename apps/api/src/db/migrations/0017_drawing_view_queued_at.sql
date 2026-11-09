-- 0017 When the drawing view was queued (security review L4): a view stuck in 'queued' because the
-- Redis message was lost can be requeued by POST once it is older than CAD_STALE_AFTER_MINUTES.
-- Set by the API when queued. The worker need not clear it; only queued rows must have it.

ALTER TABLE cad_files ADD COLUMN view_queued_at timestamptz;

UPDATE cad_files SET view_queued_at = now() WHERE view_status = 'queued';

ALTER TABLE cad_files
  ADD CONSTRAINT cad_files_view_queued_check
    CHECK (view_status <> 'queued' OR view_queued_at IS NOT NULL);
