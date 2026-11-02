import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../lib/api';
import { dropCoords, lanePlace, pickupCoords, type LatLng } from '../lib/laneCoords';
import { pctLabel, settlementPreview, usd } from '../lib/settlementPreview';
import type { Load, PlatformConfig, RateCatalog } from '../types/api';

interface LoadBoardMapProps {
  loads: Load[];
  focusedId: string | null;
  catalog?: RateCatalog;
  config?: PlatformConfig;
  onFocus: (loadId: string) => void;
  onBook: (load: Load) => void;
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

export function stopIcon(kind: 'pickup' | 'drop'): L.DivIcon {
  const label = kind === 'pickup' ? 'Pickup' : 'Drop';
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

function equipmentLabel(load: Load, catalog?: RateCatalog): string {
  return catalog?.cards.find((card) => card.equipment_key === load.equipment_type)?.label
    || load.equipment_type.replaceAll('_', ' ');
}

interface LoadSheetProps {
  load: Load;
  index: number;
  total: number;
  catalog?: RateCatalog;
  config?: PlatformConfig;
  onPrev: () => void;
  onNext: () => void;
  onBook: (load: Load) => void;
}

const LoadSheet: React.FC<LoadSheetProps> = ({
  load,
  index,
  total,
  catalog,
  config,
  onPrev,
  onNext,
  onBook
}) => {
  const preview = settlementPreview(load.miles, load.rate_per_mile, config, {
    factored: load.same_day_funding_offered
  });
  const pickup = lanePlace(load.origin_city, load.origin_state, load.origin_address);
  const drop = lanePlace(load.dest_city, load.dest_state, load.dest_address);

  return (
    <article className="load-board-sheet" aria-live="polite">
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="eyebrow">Available load</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="load-board-step"
            onClick={onPrev}
            aria-label="Previous load"
            disabled={total < 2}
          >
            ‹
          </button>
          <span className="font-mono text-[0.72rem] font-bold uppercase tracking-wider text-[#5B6168]">
            {index + 1} of {total}
          </span>
          <button
            type="button"
            className="load-board-step"
            onClick={onNext}
            aria-label="Next load"
            disabled={total < 2}
          >
            ›
          </button>
        </div>
      </div>

      <p className="font-mono text-[0.68rem] font-bold uppercase tracking-wider text-[#0F5132] mb-0.5">
        Pickup
      </p>
      <h3 className="text-lg font-serif font-black uppercase leading-tight text-[#14171A] mb-1">
        {pickup}
      </h3>
      <p className="font-mono text-[0.72rem] text-[#5B6168] mb-2">
        Drop {drop}
      </p>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-serif font-black text-2xl leading-tight whitespace-nowrap text-[#14171A]">
            {usd(preview.gross)}
          </div>
          <div className="font-mono text-[0.72rem] text-[#5B6168] mt-1">
            {preview.miles.toLocaleString()} mi · {equipmentLabel(load, catalog)} · net {usd(preview.net)} after {pctLabel(preview.feePct)}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onBook(load)}
          className="btn primary py-2.5 px-4 text-xs shrink-0"
        >
          Book Load Direct
        </button>
      </div>
    </article>
  );
};

export const LoadBoardMap: React.FC<LoadBoardMapProps> = ({
  loads,
  focusedId,
  catalog,
  config,
  onFocus,
  onBook
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
  const focusedIndex = focused ? Math.max(0, loads.findIndex((load) => load.id === focused.id)) : 0;

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
        icon: stopIcon('pickup'),
        zIndexOffset: 600,
        keyboard: false
      })
        .addTo(map)
        .bindPopup(lanePlace(focused.origin_city, focused.origin_state, focused.origin_address));
    }
    if (dest) {
      dropRef.current = L.marker([dest.lat, dest.lng], {
        icon: stopIcon('drop'),
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
        paddingTopLeft: [28, 36],
        paddingBottomRight: [28, 150],
        maxZoom: 11
      });
    } else if (origin) {
      map.setView([origin.lat, origin.lng], 8);
    }
  }, [focused, geometry, extraPins]);

  const step = (dir: number) => {
    if (loads.length === 0) return;
    const next = (focusedIndex + dir + loads.length) % loads.length;
    onFocus(loads[next].id);
  };

  return (
    <div className="load-board-stage mb-10">
      <div ref={mapElRef} className="lane-map load-board-map" role="application" aria-label="Available load map" />
      <p className="load-board-legend">
        Mile pins are pickups. Open a load to see the dock and the drop.
      </p>
      {focused ? (
        <LoadSheet
          load={focused}
          index={focusedIndex}
          total={loads.length}
          catalog={catalog}
          config={config}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onBook={onBook}
        />
      ) : null}
    </div>
  );
};
