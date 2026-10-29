-- Uploaded documents live in Postgres, not on the web server's disk.
--
-- The app writes driver documents (CDL photo, DOT authority, COI) and serves
-- them back by URL. On Render the container filesystem is ephemeral, so every
-- deploy wiped ./uploads and the stored `file_url` values began returning 404.
-- The bytes now sit in this table and are read back through SECURITY DEFINER
-- routines, the same pattern the other public paths use.

CREATE TABLE IF NOT EXISTS uploaded_files (
  id            TEXT PRIMARY KEY,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  data          BYTEA NOT NULL,
  uploaded_by   TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE uploaded_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON uploaded_files FROM asoc_app;

CREATE OR REPLACE FUNCTION app_store_upload(
  p_id TEXT,
  p_content_type TEXT,
  p_data BYTEA
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_current_role() = 'anon' THEN
    RAISE EXCEPTION 'Uploads require a signed-in account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO uploaded_files (id, content_type, size_bytes, data, uploaded_by)
  VALUES (p_id, p_content_type, octet_length(p_data), p_data, app_current_user_id());
END $$;

CREATE OR REPLACE FUNCTION app_get_upload(p_id TEXT)
RETURNS TABLE (content_type TEXT, data BYTEA)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.content_type, f.data FROM uploaded_files f WHERE f.id = p_id
$$;

GRANT EXECUTE ON FUNCTION app_store_upload(TEXT, TEXT, BYTEA) TO asoc_app;
GRANT EXECUTE ON FUNCTION app_get_upload(TEXT) TO asoc_app;
