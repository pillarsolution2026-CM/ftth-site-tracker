-- 0016 «عارض الرسومات» (ADR-039): the flattened drawing the canvas viewer draws.
--
-- The worker job `cad.render_view` writes `projects/<p>/cad/<f>/view-<jobId>.json.gz` and sets the view_*
-- columns; the API queues it (view_status 'queued' + view_job_id) and serves the file. A job whose
-- id is no longer view_job_id is dropped by the worker. The columns are derived data, so the
-- original-immutability trigger (which guards only identity and fingerprint) is not affected.

ALTER TABLE cad_files
  ADD COLUMN view_status      text        NOT NULL DEFAULT 'none',
  ADD COLUMN view_job_id      uuid,
  ADD COLUMN view_storage_key text,
  ADD COLUMN view_size_bytes  integer,
  ADD COLUMN view_error_code  text,
  ADD COLUMN view_rendered_at timestamptz;

ALTER TABLE cad_files
  ADD CONSTRAINT cad_files_view_status_check
    CHECK (view_status IN ('none', 'queued', 'ready', 'failed')),
  ADD CONSTRAINT cad_files_view_size_check
    CHECK (view_size_bytes IS NULL OR view_size_bytes > 0),
  ADD CONSTRAINT cad_files_view_ready_check
    CHECK (view_status <> 'ready'
           OR (view_storage_key IS NOT NULL AND view_size_bytes IS NOT NULL
               AND view_rendered_at IS NOT NULL)),
  ADD CONSTRAINT cad_files_view_failed_check
    CHECK (view_status <> 'failed' OR view_error_code IS NOT NULL);
