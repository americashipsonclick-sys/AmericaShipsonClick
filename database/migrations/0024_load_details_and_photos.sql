-- What a driver needs to decide on a load, and photos of the freight.
--
-- Until now a load was a lane, a price and a free-text note. The load detail
-- view shows the appointment, the dock, where to park and what the freight is,
-- so those become columns (delivery_date and commodity already exist from
-- migration 0007, though nothing wrote them). All of them are optional: older
-- loads have none of them, and the view hides what the shipper did not state.
--
-- Photos reuse uploaded_files (migration 0020) for the bytes, so a deploy cannot
-- erase them. load_photos ties a file to a load. Unlike a carrier document, a
-- photo is not served by the public /uploads path: its file id never leaves the
-- API, and the bytes are read through a route that checks who is asking.

-- ---------------------------------------------------------------------------
-- 1. LOAD DETAILS
-- ---------------------------------------------------------------------------

ALTER TABLE loads ADD COLUMN IF NOT EXISTS load_type           TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_appt_start   TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_appt_end     TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_dock         TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_parking      TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_checkin      TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_appt_start TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_appt_end   TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_dock       TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_parking    TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS receiving_hours     TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pallets             INTEGER;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS temperature_f       INTEGER;
-- NULL is "not stated", which is different from "no" for hazardous freight.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS hazmat              BOOLEAN;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS requires_twic       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS requires_team       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS requires_load_bars  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS payment_terms       TEXT;

DO $$ BEGIN
  ALTER TABLE loads ADD CONSTRAINT loads_load_type_known
    CHECK (load_type IS NULL OR load_type IN ('full_truckload', 'partial'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE loads ADD CONSTRAINT loads_appointment_format
    CHECK (
      (pickup_appt_start   IS NULL OR pickup_appt_start   ~ '^([01]\d|2[0-3]):[0-5]\d$') AND
      (pickup_appt_end     IS NULL OR pickup_appt_end     ~ '^([01]\d|2[0-3]):[0-5]\d$') AND
      (delivery_appt_start IS NULL OR delivery_appt_start ~ '^([01]\d|2[0-3]):[0-5]\d$') AND
      (delivery_appt_end   IS NULL OR delivery_appt_end   ~ '^([01]\d|2[0-3]):[0-5]\d$')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE loads ADD CONSTRAINT loads_delivery_date_format
    CHECK (delivery_date IS NULL OR delivery_date ~ '^\d{4}-\d{2}-\d{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE loads ADD CONSTRAINT loads_detail_lengths
    CHECK (
      (pickup_dock      IS NULL OR char_length(pickup_dock)      <= 60)  AND
      (delivery_dock    IS NULL OR char_length(delivery_dock)    <= 60)  AND
      (pickup_parking   IS NULL OR char_length(pickup_parking)   <= 300) AND
      (delivery_parking IS NULL OR char_length(delivery_parking) <= 300) AND
      (pickup_checkin   IS NULL OR char_length(pickup_checkin)   <= 300) AND
      (receiving_hours  IS NULL OR char_length(receiving_hours)  <= 120) AND
      (commodity        IS NULL OR char_length(commodity)        <= 120) AND
      (payment_terms    IS NULL OR char_length(payment_terms)    <= 120)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE loads ADD CONSTRAINT loads_pallets_range
    CHECK (pallets IS NULL OR pallets BETWEEN 1 AND 60);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE loads ADD CONSTRAINT loads_temperature_range
    CHECK (temperature_f IS NULL OR temperature_f BETWEEN -40 AND 120);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. SHIPPER FACTS FOR THE LOAD BOARD
-- ---------------------------------------------------------------------------
-- Still only public facts: never billing_email or the owning user_id.

CREATE OR REPLACE VIEW public_shipper_view AS
SELECT
  s.id,
  s.company_name,
  s.created_at AS member_since,
  (SELECT COUNT(*)::INTEGER FROM loads l WHERE l.shipper_id = s.id) AS loads_posted
FROM shipper_profiles s;

-- ---------------------------------------------------------------------------
-- 3. FREIGHT PHOTOS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS load_photos (
  id           TEXT PRIMARY KEY,
  load_id      TEXT NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL UNIQUE REFERENCES uploaded_files(id) ON DELETE RESTRICT,
  caption      TEXT CHECK (caption IS NULL OR char_length(caption) BETWEEN 1 AND 120),
  uploaded_by  TEXT,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_load_photos_load ON load_photos (load_id, created_at);

ALTER TABLE load_photos ENABLE ROW LEVEL SECURITY;

-- Read-only for the app role: writes go through the routines below, which keep
-- the file and its load_photos row together and hold the per-load limit.
GRANT SELECT ON load_photos TO asoc_app;

-- The same audience as the load: the shipper who posted it, an admin, and
-- carriers while it is open or once they hold a booking on it. Other shippers
-- do not read each other's freight.
DROP POLICY IF EXISTS load_photos_select ON load_photos;
CREATE POLICY load_photos_select ON load_photos FOR SELECT USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1 FROM loads l
    WHERE l.id = load_photos.load_id
      AND (
        l.shipper_id = app_current_shipper_id()
        OR (
          app_current_driver_id() IS NOT NULL
          AND (
            l.status = 'open'
            OR EXISTS (
              SELECT 1 FROM bookings b
              WHERE b.load_id = l.id
                AND b.driver_id = app_current_driver_id()
                AND b.status <> 'cancelled'
            )
          )
        )
      )
  )
);

-- Photos change only while a load is open: a driver who booked it decided on
-- what they saw. Locking the load row serializes two uploads racing for the
-- last slot.
CREATE OR REPLACE FUNCTION app_load_photos_lock(p_load_id TEXT) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target loads%ROWTYPE;
BEGIN
  SELECT * INTO target FROM loads WHERE id = p_load_id FOR UPDATE;
  -- IS DISTINCT FROM: a caller with no shipper id compares as NULL, not as false.
  IF NOT FOUND OR (NOT app_is_admin() AND target.shipper_id IS DISTINCT FROM app_current_shipper_id()) THEN
    RAISE EXCEPTION 'Load not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF target.status <> 'open' THEN
    RAISE EXCEPTION 'Photos can only be changed while the load is open'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

REVOKE ALL ON FUNCTION app_load_photos_lock(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_add_load_photo(
  p_id TEXT,
  p_file_id TEXT,
  p_load_id TEXT,
  p_content_type TEXT,
  p_data BYTEA,
  p_caption TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM app_load_photos_lock(p_load_id);

  IF (SELECT COUNT(*) FROM load_photos WHERE load_id = p_load_id) >= 3 THEN
    RAISE EXCEPTION 'A load can have at most 3 photos'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO uploaded_files (id, content_type, size_bytes, data, uploaded_by)
  VALUES (p_file_id, p_content_type, octet_length(p_data), p_data, app_current_user_id());

  INSERT INTO load_photos (id, load_id, file_id, caption, uploaded_by)
  VALUES (p_id, p_load_id, p_file_id, NULLIF(btrim(p_caption), ''), app_current_user_id());
END $$;

CREATE OR REPLACE FUNCTION app_remove_load_photo(p_id TEXT, p_load_id TEXT) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed_file TEXT;
BEGIN
  PERFORM app_load_photos_lock(p_load_id);

  DELETE FROM load_photos WHERE id = p_id AND load_id = p_load_id
  RETURNING file_id INTO removed_file;
  IF removed_file IS NULL THEN
    RAISE EXCEPTION 'Photo not found' USING ERRCODE = 'no_data_found';
  END IF;

  DELETE FROM uploaded_files WHERE id = removed_file;
END $$;

GRANT EXECUTE ON FUNCTION app_add_load_photo(TEXT, TEXT, TEXT, TEXT, BYTEA, TEXT) TO asoc_app;
GRANT EXECUTE ON FUNCTION app_remove_load_photo(TEXT, TEXT) TO asoc_app;
