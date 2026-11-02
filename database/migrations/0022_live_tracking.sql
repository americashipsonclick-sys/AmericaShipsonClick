-- Live truck tracking: the driver's phone reports where the truck is while a
-- load is active, and the shipper of that load can watch it move.
--
-- Three rules live here rather than in the route:
--
--   * A position is accepted only from the booked driver, only for a booking
--     that is still active on a load that is booked or in transit. Tracking
--     starts when the driver accepts the load and stops at delivery or
--     cancellation, so nothing is recorded off the job.
--   * A trail is readable by the parties to the load and admins, nobody else.
--   * Coming within half a mile of the next stop writes an `arrived_pickup` or
--     `arrived_delivery` timeline event, once per booking, from the same
--     trigger that stores the position.

ALTER TYPE load_event_type ADD VALUE IF NOT EXISTS 'arrived_pickup';
ALTER TYPE load_event_type ADD VALUE IF NOT EXISTS 'arrived_delivery';

-- ---------------------------------------------------------------------------
-- 1. POSITIONS
-- ---------------------------------------------------------------------------
-- Keyed on the phone's own timestamp: a phone that lost signal re-sends its
-- backlog, and a point it already delivered is skipped instead of doubled.

CREATE TABLE IF NOT EXISTS booking_locations (
  booking_id   TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  recorded_at  TIMESTAMP WITH TIME ZONE NOT NULL,
  lat          DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m   REAL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  speed_mps    REAL CHECK (speed_mps IS NULL OR speed_mps >= 0),
  heading_deg  REAL CHECK (heading_deg IS NULL OR heading_deg BETWEEN 0 AND 360),
  received_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (booking_id, recorded_at)
);

-- Great-circle miles. Close enough for a half-mile arrival radius.
CREATE OR REPLACE FUNCTION app_miles_between(
  lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION,
  lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION
) RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE AS $$
  SELECT 2 * 3958.8 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )))
$$;

GRANT EXECUTE ON FUNCTION app_miles_between(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO asoc_app;

-- ---------------------------------------------------------------------------
-- 2. ONLY ON THE JOB
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION booking_locations_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  trip RECORD;
BEGIN
  -- Locking the booking makes two uploads for one trip apply one after the
  -- other, so the arrival check below never logs the same stop twice.
  SELECT b.status, b.booked_at, l.status AS load_status
    INTO trip
    FROM bookings b
    JOIN loads l ON l.id = b.load_id
   WHERE b.id = NEW.booking_id
     AND b.driver_id = app_current_driver_id()
     FOR UPDATE OF b;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking % not found', NEW.booking_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF trip.status <> 'active' OR trip.load_status NOT IN ('booked', 'in_transit') THEN
    RAISE EXCEPTION 'Tracking is off: booking % is not an active trip', NEW.booking_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A point from before the load was accepted is off the job. It is dropped
  -- rather than rejected so one stale point cannot fail a whole backlog. The
  -- two minutes allow for a phone clock running a little behind the server.
  IF NEW.recorded_at < trip.booked_at - interval '2 minutes' THEN
    RETURN NULL;
  END IF;

  -- A phone clock running ahead must not put the truck in the future.
  NEW.recorded_at := LEAST(NEW.recorded_at, now());
  NEW.received_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS booking_locations_guard_trg ON booking_locations;
CREATE TRIGGER booking_locations_guard_trg BEFORE INSERT ON booking_locations
  FOR EACH ROW EXECUTE FUNCTION booking_locations_guard();

-- ---------------------------------------------------------------------------
-- 3. ARRIVALS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION booking_locations_arrivals() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  trip      RECORD;
  stop_evt  load_event_type;
  stop_lat  DOUBLE PRECISION;
  stop_lng  DOUBLE PRECISION;
  stop_city TEXT;
  stop_st   TEXT;
BEGIN
  SELECT b.load_id, b.picked_up_at,
         l.origin_lat, l.origin_lng, l.origin_city, l.origin_state,
         l.dest_lat, l.dest_lng, l.dest_city, l.dest_state
    INTO trip
    FROM bookings b
    JOIN loads l ON l.id = b.load_id
   WHERE b.id = NEW.booking_id;

  -- Until the driver marks the load picked up, the next stop is the pickup.
  IF trip.picked_up_at IS NULL THEN
    stop_evt := 'arrived_pickup';
    stop_lat := trip.origin_lat;  stop_lng := trip.origin_lng;
    stop_city := trip.origin_city; stop_st := trip.origin_state;
  ELSE
    stop_evt := 'arrived_delivery';
    stop_lat := trip.dest_lat;    stop_lng := trip.dest_lng;
    stop_city := trip.dest_city;   stop_st := trip.dest_state;
  END IF;

  IF stop_lat IS NULL OR stop_lng IS NULL
     OR app_miles_between(NEW.lat, NEW.lng, stop_lat, stop_lng) > 0.5 THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM load_events e
     WHERE e.booking_id = NEW.booking_id AND e.event_type = stop_evt
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM app_log_load_event(
    trip.load_id, NEW.booking_id, stop_evt, NULL, NULL, NULL,
    stop_city, stop_st,
    jsonb_build_object('lat', NEW.lat, 'lng', NEW.lng, 'recorded_at', NEW.recorded_at)
  );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS booking_locations_arrivals_trg ON booking_locations;
CREATE TRIGGER booking_locations_arrivals_trg AFTER INSERT ON booking_locations
  FOR EACH ROW EXECUTE FUNCTION booking_locations_arrivals();

-- ---------------------------------------------------------------------------
-- 4. ACCESS
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON booking_locations TO asoc_app;

ALTER TABLE booking_locations ENABLE ROW LEVEL SECURITY;

-- Where a driver has been is personal. The trail is shown to the shipper whose
-- freight is on the truck, the driver, and admins.
DROP POLICY IF EXISTS booking_locations_select ON booking_locations;
CREATE POLICY booking_locations_select ON booking_locations FOR SELECT USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.id = booking_locations.booking_id AND b.driver_id = app_current_driver_id()
  )
  OR EXISTS (
    SELECT 1 FROM bookings b
    JOIN loads l ON l.id = b.load_id
    WHERE b.id = booking_locations.booking_id AND l.shipper_id = app_current_shipper_id()
  )
);

-- Admins read trails but never write them: a position is the driver's phone
-- speaking, not somebody's edit.
DROP POLICY IF EXISTS booking_locations_insert ON booking_locations;
CREATE POLICY booking_locations_insert ON booking_locations FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.id = booking_locations.booking_id AND b.driver_id = app_current_driver_id()
  )
);
