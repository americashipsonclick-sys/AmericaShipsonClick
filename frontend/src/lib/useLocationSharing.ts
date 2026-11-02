import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { TrackPoint } from '../types/api';

export type SharingStatus = 'off' | 'starting' | 'on' | 'denied' | 'unavailable' | 'ended';

/**
 * Which fixes are kept: every 30 s while moving, at once after a long move,
 * and every 5 min while parked, so a truck at a dock still shows as reporting.
 */
const MOVING_INTERVAL_MS = 30_000;
const PARKED_INTERVAL_MS = 5 * 60_000;
const MOVED_M = 50;
const LONG_MOVE_M = 500;
/** Kept points go up together on this beat, well under the server's 30 uploads a minute. */
const FLUSH_MS = 15_000;
/** About 16 hours of points at one per 30 s; older ones are dropped first. */
const MAX_QUEUE = 2000;
/** The server's per-upload cap. */
const BATCH = 200;

const queueKey = (bookingId: string) => `asoc_trip_queue_${bookingId}`;
const sharingKey = (bookingId: string) => `asoc_trip_sharing_${bookingId}`;

// Storage can be full, blocked, or missing in a private window. The queue
// then lives in memory only, which still covers a short loss of signal.
function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Keep going without persistence.
  }
}

function loadQueue(bookingId: string): TrackPoint[] {
  try {
    const parsed = JSON.parse(readStore(queueKey(bookingId)) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(bookingId: string, queue: TrackPoint[]) {
  writeStore(queueKey(bookingId), queue.length ? JSON.stringify(queue) : null);
}

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function finiteOrNull(value: number | null | undefined, min: number, max: number): number | null {
  return value != null && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function toPoint(pos: GeolocationPosition): TrackPoint {
  return {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy_m: finiteOrNull(pos.coords.accuracy, 0, 1_000_000),
    speed_mps: finiteOrNull(pos.coords.speed, 0, 100),
    heading_deg: finiteOrNull(pos.coords.heading, 0, 360),
    recorded_at: new Date(pos.timestamp).toISOString()
  };
}

/**
 * Shares the driver's position for one booking while `enabled` (the trip is
 * active) and the driver has pressed Start.
 *
 * A browser only reports location while the page is open on screen, so the
 * screen is kept awake while sharing, and points recorded without signal wait
 * on the phone and upload once it is back. The server answering "trip over"
 * stops sharing for good and calls `onEnded`.
 */
export function useLocationSharing(bookingId: string | null, enabled: boolean, onEnded: () => void) {
  const [wants, setWants] = useState(false);
  const [status, setStatus] = useState<SharingStatus>('off');
  const [position, setPosition] = useState<TrackPoint | null>(null);
  const [lastSentAt, setLastSentAt] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const queueRef = useRef<TrackPoint[]>([]);
  const lastKeptRef = useRef<TrackPoint | null>(null);
  const sendingRef = useRef(false);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  // A reload resumes where the driver left off: same backlog, same choice.
  useEffect(() => {
    queueRef.current = bookingId ? loadQueue(bookingId) : [];
    lastKeptRef.current = null;
    setQueued(queueRef.current.length);
    setWants(bookingId ? readStore(sharingKey(bookingId)) === '1' : false);
    setStatus('off');
  }, [bookingId]);

  const flush = useCallback(async () => {
    if (!bookingId || sendingRef.current || queueRef.current.length === 0) return;
    if (navigator.onLine === false) return;
    sendingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const batch = queueRef.current.slice(0, BATCH);
        const result = await api.sendLocations(bookingId, batch);
        if (result.stopped) {
          queueRef.current = [];
          saveQueue(bookingId, []);
          writeStore(sharingKey(bookingId), null);
          setQueued(0);
          setWants(false);
          setStatus('ended');
          onEndedRef.current();
          return;
        }
        // New points are appended while a batch is in flight, so drop from the front.
        queueRef.current = queueRef.current.slice(batch.length);
        saveQueue(bookingId, queueRef.current);
        setQueued(queueRef.current.length);
        setLastSentAt(batch[batch.length - 1].recorded_at);
      }
      setUploadError(null);
    } catch (err) {
      // Offline or the server is down: the points stay queued for the next try.
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      sendingRef.current = false;
    }
  }, [bookingId]);

  useEffect(() => {
    if (!bookingId || !enabled || !wants) {
      setStatus((s) => (s === 'ended' || s === 'denied' || s === 'unavailable' ? s : 'off'));
      // A backlog from an earlier session still goes up while the trip is active.
      if (bookingId && enabled) void flush();
      return;
    }
    if (!('geolocation' in navigator)) {
      setStatus('unavailable');
      return;
    }

    setStatus('starting');
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const point = toPoint(pos);
        setPosition(point);
        setStatus('on');

        const prev = lastKeptRef.current;
        const elapsed = prev ? Date.parse(point.recorded_at) - Date.parse(prev.recorded_at) : Infinity;
        const moved = prev ? metersBetween(prev, point) : Infinity;
        const due = moved >= LONG_MOVE_M
          || (elapsed >= MOVING_INTERVAL_MS && moved >= MOVED_M)
          || elapsed >= PARKED_INTERVAL_MS;
        // The server keys points on their timestamp; a repeat would be dropped anyway.
        if (!due || prev?.recorded_at === point.recorded_at) return;

        lastKeptRef.current = point;
        queueRef.current = [...queueRef.current, point].slice(-MAX_QUEUE);
        saveQueue(bookingId, queueRef.current);
        setQueued(queueRef.current.length);
        // The first fix goes up at once so the shipper sees the truck; the rest ride the timer.
        if (!prev) void flush();
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          writeStore(sharingKey(bookingId), null);
          setWants(false);
          setStatus('denied');
        }
        // No fix yet or a timeout: the watch keeps trying on its own.
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 60_000 }
    );

    void flush();
    const timer = window.setInterval(() => void flush(), FLUSH_MS);
    const onOnline = () => void flush();
    window.addEventListener('online', onOnline);
    return () => {
      navigator.geolocation.clearWatch(watchId);
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [bookingId, enabled, wants, flush]);

  // The screen staying on is what keeps a web page reporting; the lock is
  // dropped by the browser whenever the page is hidden, so it is retaken.
  useEffect(() => {
    if (status !== 'on') return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (cancelled) void next.release();
        else lock = next;
      } catch {
        // Battery saver or an unsupported browser: tracking still works while the screen is on.
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void acquire();
      void flush();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [status, flush]);

  const start = useCallback(() => {
    if (!bookingId) return;
    writeStore(sharingKey(bookingId), '1');
    setWants(true);
  }, [bookingId]);

  const stop = useCallback(() => {
    if (!bookingId) return;
    writeStore(sharingKey(bookingId), null);
    setWants(false);
    void flush();
  }, [bookingId, flush]);

  return { status, position, lastSentAt, queued, uploadError, start, stop };
}
