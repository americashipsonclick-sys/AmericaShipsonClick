import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../lib/api';
import { dropCoords, lanePlace, pickupCoords, type LatLng } from '../lib/laneCoords';
import { pickupRange } from '../lib/loadFormat';
import type { Load } from '../types/api';

interface LoadBoardMapProps {
  loads: Load[];
  focusedId: string | null;
  onFocus: (loadId: string) => void;
}

function mileIcon(miles: number, active: boolean): L.DivIcon {
  const label = `${Math.round(Number(miles) || 0)} mi`;
  return L.divIcon({
    className: 'board-mile',
    html: `<span class="board-mile-dot${active ? ' is-active' : ''}">${label}</span>`,
    iconSize: [58, 28],
    iconAnchor: [29, 14]
  });
}

function escapeHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

/** With `place`, a dot on the exact spot with "Pickup · Temple TX" under it. */
export function stopIcon(kind: 'pickup' | 'drop', place?: string): L.DivIcon {
  const label = kind === 'pickup' ? 'Pickup' : 'Drop';
  if (place) {
    return L.divIcon({
      className: 'board-stop-wrap',
      html: `<span class="board-pin"><span class="board-pin-dot ${kind}"></span><span class="board-stop ${kind}">${label} · ${escapeHtml(place)}</span></span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
  }
  return L.divIcon({
    className: 'board-stop-wrap',
    html: `<span class="board-stop ${kind}">${label}</span>`,
    iconSize: [78, 28],
    iconAnchor: [39, 14]
  });
}

function offsetAround(center: LatLng, index: number, count: number): LatLng {
  if (count <= 1) return center;
  const radius = 0.18;
  const angle = (2 * Math.PI * index) / count - Math.PI / 2;
  return {
    lat: center.lat + Math.sin(angle) * radius,
    lng: center.lng + Math.cos(angle) * radius
  };
}

function groupKey(point: LatLng): string {
  return `${point.lat.toFixed(2)}|${point.lng.toFixed(2)}`;
}

const cityCache = new Map<string, LatLng | null>();
const cityInflight = new Map<string, Promise<LatLng | null>>();

function cityQueryKey(city: string, state: string): string {
  return `${city.trim().toLowerCase()}|${state.trim().toUpperCase()}`;
}

function geocodeCity(city: string, state: string): Promise<LatLng | null> {
  const key = cityQueryKey(city, state);
  if (cityCache.has(key)) return Promise.resolve(cityCache.get(key) ?? null);
  const pending = cityInflight.get(key);
  if (pending) return pending;
  const req = api.searchPlaces(`${city}, ${state}`)
    .then((hits) => {
      const hit = hits[0];
      const pin = hit ? { lat: hit.lat, lng: hit.lng } : null;
      cityCache.set(key, pin);
      cityInflight.delete(key);
      return pin;
    })
    .catch(() => {
      cityInflight.delete(key);
      return null;
    });
  cityInflight.set(key, req);
  return req;
}

export const LoadBoardMap: React.FC<LoadBoardMapProps> = ({
  loads,
  focusedId,
  onFocus
}) => {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const badgesRef = useRef<L.Marker[]>([]);
  const pickupRef = useRef<L.Marker | null>(null);
  const dropRef = useRef<L.Marker | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);
  const onFocusRef = useRef(onFocus);
  const routesRef = useRef(new Map<string, [number, number][]>());

  const [geometry, setGeometry] = useState<[number, number][]>([]);
  const [extraPins, setExtraPins] = useState<Record<string, { pickup?: LatLng; drop?: LatLng }>>({});

  onFocusRef.current = onFocus;

  const pinFor = (load: Load): { pickup: LatLng | null; drop: LatLng | null } => ({
    pickup: pickupCoords(load) ?? extraPins[load.id]?.pickup ?? null,
    drop: dropCoords(load) ?? extraPins[load.id]?.drop ?? null
  });

  const focused = useMemo(
    () => loads.find((load) => load.id === focusedId) ?? loads[0] ?? null,
    [loads, focusedId]
  );

  useEffect(() => {
    let cancelled = false;
    const missing = loads.filter((load) => !pickupCoords(load) || !dropCoords(load));
    if (missing.length === 0) return;

    Promise.all(missing.map(async (load) => {
      const pickup = pickupCoords(load) ?? await geocodeCity(load.origin_city, load.origin_state);
      const drop = dropCoords(load) ?? await geocodeCity(load.dest_city, load.dest_state);
      return [load.id, { pickup: pickup ?? undefined, drop: drop ?? undefined }] as const;
    })).then((entries) => {
      if (cancelled) return;
      setExtraPins((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });

    return () => {
      cancelled = true;
    };
  }, [loads]);

  const pickupGroups = useMemo(() => {
    const groups = new Map<string, Load[]>();
    for (const load of loads) {
      const pickup = pinFor(load).pickup;
      if (!pickup) continue;
      const key = groupKey(pickup);
      const list = groups.get(key);
      if (list) list.push(load);
      else groups.set(key, [load]);
    }
    return groups;
  }, [loads, extraPins]);

  useEffect(() => {
    const el = mapElRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      center: [39.5, -98.35],
      zoom: 5,
      minZoom: 3,
      maxZoom: 18,
      zoomControl: true,
      attributionControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    mapRef.current = map;
    const sizeTimer = window.setTimeout(() => map.invalidateSize(), 80);

    return () => {
      window.clearTimeout(sizeTimer);
      map.remove();
      mapRef.current = null;
      badgesRef.current = [];
      pickupRef.current = null;
      dropRef.current = null;
      lineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!focused) {
      setGeometry([]);
      return;
    }
    const origin = pinFor(focused).pickup;
    const dest = pinFor(focused).drop;
    if (!origin || !dest) {
      setGeometry([]);
      return;
    }

    const cached = routesRef.current.get(focused.id);
    if (cached) {
      setGeometry(cached);
      return;
    }

    let cancelled = false;
    api.drivingRoute(origin, dest)
      .then((route) => {
        if (cancelled) return;
        routesRef.current.set(focused.id, route.geometry);
        setGeometry(route.geometry);
      })
      .catch(() => {
        if (!cancelled) setGeometry([]);
      });

    return () => {
      cancelled = true;
    };
  }, [focused, extraPins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of badgesRef.current) {
      map.removeLayer(marker);
    }
    badgesRef.current = [];

    pickupGroups.forEach((group) => {
      const base = pinFor(group[0]).pickup;
      if (!base) return;
      group.forEach((load, index) => {
        if (focused?.id === load.id) return;
        const point = offsetAround(base, index, group.length);
        const marker = L.marker([point.lat, point.lng], {
          icon: mileIcon(load.miles, false),
          keyboard: true,
          title: lanePlace(load.origin_city, load.origin_state, load.origin_address)
        }).addTo(map);
        marker.on('click', () => onFocusRef.current(load.id));
        badgesRef.current.push(marker);
      });
    });
  }, [pickupGroups, focused?.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const clear = (layer: L.Layer | null) => {
      if (layer) map.removeLayer(layer);
    };
    clear(pickupRef.current);
    clear(dropRef.current);
    clear(lineRef.current);
    pickupRef.current = null;
    dropRef.current = null;
    lineRef.current = null;

    if (!focused) return;

    const origin = pinFor(focused).pickup;
    const dest = pinFor(focused).drop;
    if (origin) {
      pickupRef.current = L.marker([origin.lat, origin.lng], {
        icon: stopIcon('pickup', `${focused.origin_city} ${focused.origin_state}`),
        zIndexOffset: 600,
        keyboard: false
      })
        .addTo(map)
        .bindPopup(lanePlace(focused.origin_city, focused.origin_state, focused.origin_address));
    }
    if (dest) {
      dropRef.current = L.marker([dest.lat, dest.lng], {
        icon: stopIcon('drop', `${focused.dest_city} ${focused.dest_state}`),
        zIndexOffset: 600,
        keyboard: false
      })
        .addTo(map)
        .bindPopup(lanePlace(focused.dest_city, focused.dest_state, focused.dest_address));
    }

    const linePoints = geometry.length >= 2
      ? geometry
      : origin && dest
        ? [[origin.lat, origin.lng], [dest.lat, dest.lng]] as [number, number][]
        : [];

    if (linePoints.length >= 2) {
      lineRef.current = L.polyline(linePoints, {
        color: '#0F5132',
        weight: 4,
        opacity: 0.9
      }).addTo(map);
      map.fitBounds(lineRef.current.getBounds(), {
        paddingTopLeft: [90, 36],
        paddingBottomRight: [90, 64],
        maxZoom: 11
      });
    } else if (origin) {
      map.setView([origin.lat, origin.lng], 8);
    }
  }, [focused, geometry, extraPins]);

  const range = pickupRange(loads);

  return (
    <div className="load-board-stage mb-8">
      <div ref={mapElRef} className="lane-map load-board-map" role="application" aria-label="Available load map" />
      <p className="load-board-count">
        {loads.length} load{loads.length === 1 ? '' : 's'}{range ? ` · ${range}` : ''}
      </p>
    </div>
  );
};
