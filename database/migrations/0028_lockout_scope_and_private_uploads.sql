-- Two access rules that were looser than they looked.
--
-- 1. LOGIN LOCKOUT WAS KEYED ON EMAIL ALONE
--
-- Five wrong passwords against an address locked that account for everyone,
-- so anyone who knew a user's email could keep them out indefinitely. The
-- lockout now follows who is guessing:
--
--   same email + same address   5 failures   the ordinary case: one person
--                                            guessing one account
--   same address, any email    20 failures   one machine walking a list of
--                                            accounts
--   same email, any address    50 failures   a distributed guess at one
--                                            account; high enough that a single
--                                            address is stopped by the row above
--                                            long before it can trip this
--
-- All three share the 15 minute window. The one-argument function stays for
-- the server version still running while a deploy rolls out.

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time
  ON auth_login_attempts (ip_address, attempted_at DESC);

CREATE OR REPLACE FUNCTION app_login_lockout_seconds(p_email TEXT, p_ip TEXT)
RETURNS INTEGER LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  window_secs    CONSTANT INTEGER := 900;   -- 15 minutes
  pair_failures  CONSTANT INTEGER := 5;
  ip_failures    CONSTANT INTEGER := 20;
  email_failures CONSTANT INTEGER := 50;
  since          TIMESTAMP WITH TIME ZONE := now() - make_interval(secs => window_secs);
  failures       INTEGER;
  newest         TIMESTAMP WITH TIME ZONE;
  locked_until   TIMESTAMP WITH TIME ZONE;
BEGIN
  IF p_ip IS NOT NULL AND p_ip <> '' THEN
    SELECT count(*), max(attempted_at) INTO failures, newest
    FROM auth_login_attempts
    WHERE lower(email) = lower(p_email) AND ip_address = p_ip
      AND NOT succeeded AND attempted_at > since;
    IF failures >= pair_failures THEN
      locked_until := newest + make_interval(secs => window_secs);
    END IF;

    SELECT count(*), max(attempted_at) INTO failures, newest
    FROM auth_login_attempts
    WHERE ip_address = p_ip AND NOT succeeded AND attempted_at > since;
    IF failures >= ip_failures THEN
      locked_until := GREATEST(locked_until, newest + make_interval(secs => window_secs));
    END IF;
  END IF;

  SELECT count(*), max(attempted_at) INTO failures, newest
  FROM auth_login_attempts
  WHERE lower(email) = lower(p_email) AND NOT succeeded AND attempted_at > since;
  IF failures >= email_failures THEN
    locked_until := GREATEST(locked_until, newest + make_interval(secs => window_secs));
  END IF;

  IF locked_until IS NULL THEN
    RETURN 0;
  END IF;
  RETURN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::INTEGER);
END $$;

GRANT EXECUTE ON FUNCTION app_login_lockout_seconds(TEXT, TEXT) TO asoc_app;

-- 2. UPLOADED DOCUMENTS WERE READABLE BY ANYONE HOLDING THE LINK
--
-- /uploads/<id> served CDL photos, DOT authority letters and insurance
-- certificates with no sign-in; the random id was the only protection, and a
-- link outlives the moment it was shared. Reading one now takes the account
-- that uploaded it, or an admin.
--
-- app_get_upload stays as it is for the freight photo route, which applies its
-- own rule (the load's shipper, or a driver who can see the load) before it
-- asks for the bytes.

CREATE OR REPLACE FUNCTION app_get_own_upload(p_id TEXT)
RETURNS TABLE (content_type TEXT, data BYTEA)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.content_type, f.data
  FROM uploaded_files f
  WHERE f.id = p_id
    AND (
      app_is_admin()
      OR (app_current_user_id() IS NOT NULL AND f.uploaded_by = app_current_user_id())
    )
$$;

GRANT EXECUTE ON FUNCTION app_get_own_upload(TEXT) TO asoc_app;
