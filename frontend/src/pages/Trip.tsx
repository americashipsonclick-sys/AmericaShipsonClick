import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TripMap } from '../components/TripMap';
import { api } from '../lib/api';
import { useLocationSharing, type SharingStatus } from '../lib/useLocationSharing';
import type { TripPhase, TripTracking, User } from '../types/api';

interface TripProps {
  currentUser: User | null;
  bookingId: string | null;
  setActiveTab: (tab: string) => void;
}

/** A report older than this is called out: the phone is probably off, backgrounded, or out of signal. */
const STALE_MS = 10 * 60_000;

const PHASE_LABEL: Record<TripPhase, string> = {
  to_pickup: 'Heading to pickup',
  to_delivery: 'Loaded · heading to delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
};

const EVENT_LABEL: Record<string, string> = {
  posted: 'Load posted',
  booked: 'Driver accepted the load',
  arrived_pickup: 'Arrived at pickup',
  in_transit: 'Picked up · in transit',
  arrived_delivery: 'Arrived at delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
};

const SHARING_LABEL: Record<SharingStatus, string> = {
  off: 'Not sharing',
  starting: 'Waiting for GPS…',
  on: 'Sharing live',
  denied: 'Location blocked',
  unavailable: 'No GPS in this browser',
  ended: 'Trip ended · sharing stopped'
};

function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ${mins % 60} min ago`;
  return new Date(iso).toLocaleString();
}

function duration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function stopAddress(trip: TripTracking, stop: 'pickup' | 'delivery'): string {
  const { load } = trip;
  return stop === 'pickup'
    ? load.origin_address || `${load.origin_city}, ${load.origin_state}`
    : load.dest_address || `${load.dest_city}, ${load.dest_state}`;
}

/** Hand-off to the driver's own navigation app; we do not do turn-by-turn. */
function navLinks(coords: { lat: number; lng: number } | null, address: string) {
  const dest = coords ? `${coords.lat},${coords.lng}` : address;
  return [
    {
      label: 'Google Maps',
      href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`
    },
    { label: 'Apple Maps', href: `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}&dirflg=d` },
    {
      label: 'Waze',
      href: coords
        ? `https://waze.com/ul?ll=${coords.lat},${coords.lng}&navigate=yes`
        : `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes`
    }
  ];
}

export const Trip: React.FC<TripProps> = ({ currentUser, bookingId, setActiveTab }) => {
  const queryClient = useQueryClient();
  const isDriver = currentUser?.role === 'driver';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const { data: trip, error, isLoading } = useQuery({
    queryKey: ['trip', bookingId],
    queryFn: () => api.getTripTracking(bookingId as string),
    enabled: !!bookingId,
    // The phone reports every 30 s, so a 15 s poll is as live as the data.
    // The driver already sees their own position from the phone itself.
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      if (phase === 'delivered' || phase === 'cancelled') return false;
      return isDriver ? 30_000 : 15_000;
    },
    refetchIntervalInBackground: false
  });

  const active = trip?.phase === 'to_pickup' || trip?.phase === 'to_delivery';
  const sharing = useLocationSharing(isDriver ? bookingId : null, isDriver && active, () => {
    queryClient.invalidateQueries({ queryKey: ['trip', bookingId] });
    queryClient.invalidateQueries({ queryKey: ['bookings'] });
  });

  const pickupMutation = useMutation({
    mutationFn: () => api.markPickedUp(bookingId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trip', bookingId] });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
    }
  });

  if (!bookingId) {
    return (
      <TripNotice title="No trip selected" onBack={() => setActiveTab('dashboard')}>
        Open a trip from your dashboard.
      </TripNotice>
    );
  }

  if (isLoading) {
    return (
      <div className="py-16 text-center font-mono text-xs text-[#5B6168]">Loading trip…</div>
    );
  }

  if (error || !trip) {
    return (
      <TripNotice title="Trip not found" onBack={() => setActiveTab('dashboard')}>
        {error instanceof Error ? error.message : 'This trip is not available.'} Only the driver and the shipper on a load can open its trip.
      </TripNotice>
    );
  }

  const nextStop = trip.phase === 'to_pickup' ? 'pickup' : trip.phase === 'to_delivery' ? 'delivery' : null;
  const nextCoords = nextStop ? trip.stops[nextStop] : null;

  // The driver's own phone is fresher than the last upload; everyone else sees the server's copy.
  const localFix = isDriver && sharing.position
    && (!trip.last || Date.parse(sharing.position.recorded_at) > Date.parse(trip.last.recorded_at))
    ? sharing.position
    : null;
  const truck = localFix ?? trip.last;
  const reportedAt = trip.last?.recorded_at ?? null;
  const stale = active && (!reportedAt || now - Date.parse(reportedAt) > STALE_MS);
  const mph = truck?.speed_mps != null ? Math.round(truck.speed_mps * 2.23694) : null;

  return (
    <div className="py-10">
      <div className="max-w-295 mx-auto px-4 sm:px-6 space-y-6">
        <div className="flex flex-wrap justify-between items-end gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="eyebrow">Trip {trip.booking.id}</span>
              <span className={`trip-phase ${trip.phase}`}>{PHASE_LABEL[trip.phase]}</span>
            </div>
            <h2 className="text-2xl sm:text-3xl">
              {trip.load.origin_city}, {trip.load.origin_state} &rarr; {trip.load.dest_city}, {trip.load.dest_state}
            </h2>
            <p className="font-mono text-xs text-[#5B6168] mt-1">
              Load {trip.load.id} · {Number(trip.load.miles).toLocaleString()} mi · pickup {trip.load.pickup_date}
              {trip.load.reference_number ? ` · ref ${trip.load.reference_number}` : ''}
            </p>
          </div>
          <button onClick={() => setActiveTab('dashboard')} className="btn ghost py-2 text-xs">
            Back to dashboard
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-2">
            <TripMap
              pickup={trip.stops.pickup}
              delivery={trip.stops.delivery}
              truck={truck ? { lat: truck.lat, lng: truck.lng, heading_deg: truck.heading_deg } : null}
              trail={trip.trail}
              remaining={trip.remaining?.geometry ?? null}
              lane={trip.lane}
              nextStop={nextStop}
            />
            <p className="trip-legend">
              <span className="trip-legend-swatch trail" /> Driven
              <span className="trip-legend-swatch ahead" /> Road to next stop
              <span className="trip-legend-swatch lane" /> Pickup to delivery
            </p>
          </div>

          <div className="space-y-4">
            <section className="trip-card">
              <span className="eyebrow block">Where the truck is</span>
              {trip.phase === 'delivered' ? (
                <p className="text-sm">
                  Delivered{trip.booking.delivered_at ? ` ${new Date(trip.booking.delivered_at).toLocaleString()}` : ''}.
                </p>
              ) : trip.phase === 'cancelled' ? (
                <p className="text-sm">This booking was cancelled. Tracking is off.</p>
              ) : !truck ? (
                <p className="text-sm">
                  {isDriver
                    ? 'No location yet. Start sharing below so the shipper can follow the load.'
                    : 'Waiting for the driver’s first location. It appears once the driver starts the trip on their phone.'}
                </p>
              ) : (
                <>
                  <p className="font-mono text-xs">
                    Reported {ago(localFix ? localFix.recorded_at : reportedAt, now)}
                    {mph != null && mph > 0 ? ` · ${mph} mph` : ''}
                    {truck.accuracy_m != null ? ` · ±${Math.round(truck.accuracy_m)} m` : ''}
                  </p>
                  {trip.remaining && (
                    <p className="text-lg font-display-title">
                      {trip.remaining.miles.toLocaleString()} mi to {trip.remaining.stop}
                      <span className="block font-mono text-xs text-[#5B6168]">
                        about {duration(trip.remaining.minutes)} of driving
                      </span>
                    </p>
                  )}
                </>
              )}
              {stale && truck && !isDriver && (
                <p className="trip-warn">
                  No update for a while. The driver’s phone may be locked, on another app, or out of signal.
                </p>
              )}
              {nextStop && (
                <p className="font-mono text-xs text-[#5B6168]">
                  Next stop · {nextStop}: {stopAddress(trip, nextStop)}
                </p>
              )}
            </section>

            {isDriver && active && (
              <DriverControls
                trip={trip}
                nextStop={nextStop}
                nextCoords={nextCoords}
                sharingStatus={sharing.status}
                queued={sharing.queued}
                lastSentAt={sharing.lastSentAt}
                uploadError={sharing.uploadError}
                now={now}
                onStart={sharing.start}
                onStop={sharing.stop}
                onPickedUp={() => pickupMutation.mutate()}
                pickingUp={pickupMutation.isPending}
                pickupError={pickupMutation.error instanceof Error ? pickupMutation.error.message : null}
                onFinish={() => setActiveTab('dashboard')}
              />
            )}

            <section className="trip-card">
              <span className="eyebrow block">Timeline</span>
              <ol className="trip-timeline">
                {trip.events.map((evt, i) => (
                  <li key={`${evt.event_type}-${evt.occurred_at}-${i}`}>
                    <span className="font-bold">{EVENT_LABEL[evt.event_type] ?? evt.event_type.replaceAll('_', ' ')}</span>
                    <span className="text-[#5B6168]">
                      {new Date(evt.occurred_at).toLocaleString()}
                      {evt.location_city ? ` · ${evt.location_city}, ${evt.location_state}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};

function DriverControls({
  trip,
  nextStop,
  nextCoords,
  sharingStatus,
  queued,
  lastSentAt,
  uploadError,
  now,
  onStart,
  onStop,
  onPickedUp,
  pickingUp,
  pickupError,
  onFinish
}: {
  trip: TripTracking;
  nextStop: 'pickup' | 'delivery' | null;
  nextCoords: { lat: number; lng: number } | null;
  sharingStatus: SharingStatus;
  queued: number;
  lastSentAt: string | null;
  uploadError: string | null;
  now: number;
  onStart: () => void;
  onStop: () => void;
  onPickedUp: () => void;
  pickingUp: boolean;
  pickupError: string | null;
  onFinish: () => void;
}) {
  const sharingOn = sharingStatus === 'on' || sharingStatus === 'starting';

  return (
    <>
      <section className={`trip-card ${sharingOn ? 'is-live' : ''}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="eyebrow">Location sharing</span>
          <span className={`trip-sharing ${sharingStatus}`}>{SHARING_LABEL[sharingStatus]}</span>
        </div>
        {sharingOn ? (
          <>
            <p className="font-mono text-xs">Last sent {ago(lastSentAt, now)}</p>
            {uploadError && queued > 0 && (
              <p className="trip-warn">
                No connection. {queued} location{queued === 1 ? '' : 's'} saved on this phone will upload when signal returns.
              </p>
            )}
            <p className="text-xs text-[#5B6168]">
              Keep this page open on screen. The browser pauses location when you switch apps or lock the phone.
            </p>
            <button onClick={onStop} className="btn ghost py-1.5 px-3 text-xs">Pause sharing</button>
          </>
        ) : (
          <>
            <p className="text-xs text-[#5B6168]">
              Only the shipper of this load sees your location, and only until delivery.
            </p>
            {sharingStatus === 'denied' && (
              <p className="trip-warn">
                Location is blocked for this site. Allow it in your browser’s site settings, then tap Start again.
              </p>
            )}
            {sharingStatus !== 'unavailable' && (
              <button onClick={onStart} className="btn primary block py-2.5 text-sm">
                Start trip · share my location
              </button>
            )}
          </>
        )}
      </section>

      {nextStop && (
        <section className="trip-card">
          <span className="eyebrow block">Navigate to {nextStop}</span>
          <p className="font-mono text-xs">{stopAddress(trip, nextStop)}</p>
          <div className="flex flex-wrap gap-2">
            {navLinks(nextCoords, stopAddress(trip, nextStop)).map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="btn amber py-1.5 px-3 text-xs"
              >
                {link.label}
              </a>
            ))}
          </div>
          <p className="text-xs text-[#5B6168]">
            Car routing: check truck restrictions (height, weight, hazmat) before you follow it.
          </p>
        </section>
      )}

      <section className="trip-card">
        <span className="eyebrow block">At the stop</span>
        {nextStop === 'pickup' ? (
          <>
            <button onClick={onPickedUp} disabled={pickingUp} className="btn primary block py-2.5 text-sm">
              {pickingUp ? 'Saving…' : 'Loaded · mark picked up'}
            </button>
            {pickupError && <p className="font-mono text-xs text-[#8C2F1B]">{pickupError}</p>}
          </>
        ) : (
          <button onClick={onFinish} className="btn primary block py-2.5 text-sm">
            Delivered · upload POD &amp; settle
          </button>
        )}
      </section>
    </>
  );
}

function TripNotice({ title, children, onBack }: { title: string; children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="py-16">
      <div className="max-w-160 mx-auto px-6 text-center">
        <div className="p-8 bg-[#FAFAF7] border-2 border-[#E3A008] rounded shadow-md space-y-4">
          <span className="eyebrow block">Trip</span>
          <h2 className="text-2xl font-display-title text-[#14171A]">{title}</h2>
          <p className="text-[#5B6168] text-sm">{children}</p>
          <button onClick={onBack} className="btn amber px-8 py-3 font-mono">
            Go to dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
