import React, { useEffect, useRef } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { stopIcon } from './LoadBoardMap';
import type { TripStop } from '../types/api';

type LatLng = { lat: number; lng: number };

interface TripMapProps {
  pickup: LatLng | null;
  delivery: LatLng | null;
  truck: (LatLng & { heading_deg: number | null }) | null;
  /** Where the truck has been. */
  trail: [number, number][];
  /** Road from the truck to the next stop. */
  remaining: [number, number][] | null;
  /** Road from pickup to delivery, for context. */
  lane: [number, number][] | null;
  nextStop: TripStop | null;
}

function truckIcon(heading: number | null): L.DivIcon {
  const arrow = heading == null
    ? ''
    : `<span class="trip-truck-heading" style="transform: rotate(${Math.round(heading)}deg)"></span>`;
  return L.divIcon({
    className: 'trip-truck-wrap',
    html: `<span class="trip-truck">${arrow}<span class="trip-truck-dot"></span></span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

/**
 * The trip on a map: pickup and delivery, the truck, the road behind it and
 * the road ahead. It frames the trip once, then leaves the view alone so a
 * poll never yanks the map away from where somebody has panned.
 */
export const TripMap: React.FC<TripMapProps> = ({ pickup, delivery, truck, trail, remaining, lane, nextStop }) => {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const framedRef = useRef(false);

  useEffect(() => {
    const el = mapElRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      center: [39.5, -98.35],
      zoom: 4,
      minZoom: 3,
      maxZoom: 18,
      zoomControl: true,
      attributionControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const sizeTimer = window.setTimeout(() => map.invalidateSize(), 80);

    return () => {
      window.clearTimeout(sizeTimer);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      framedRef.current = false;
    };
  }, []);

  const frame = (focusAhead: boolean, animate = true) => {
    const map = mapRef.current;
    if (!map) return;
    // The container may have been laid out after the map was created.
    map.invalidateSize();
    const next = nextStop === 'pickup' ? pickup : nextStop === 'delivery' ? delivery : null;
    const points: L.LatLngExpression[] = focusAhead && truck && next
      ? [[truck.lat, truck.lng], [next.lat, next.lng]]
      : [pickup, delivery, truck].filter((p): p is LatLng => !!p).map((p) => [p.lat, p.lng] as [number, number]);
    if (points.length === 0) return;
    if (points.length === 1) map.setView(points[0], 12, { animate });
    else map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 14, animate });
  };

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    if (lane && lane.length > 1) {
      L.polyline(lane, { color: '#545B62', weight: 3, opacity: 0.55, dashArray: '6 8' }).addTo(layer);
    }
    if (trail.length > 1) {
      L.polyline(trail, { color: '#0F5132', weight: 4, opacity: 0.9 }).addTo(layer);
    }
    if (remaining && remaining.length > 1) {
      L.polyline(remaining, { color: '#E3A008', weight: 5, opacity: 0.95 }).addTo(layer);
    }
    if (pickup) {
      L.marker([pickup.lat, pickup.lng], { icon: stopIcon('pickup'), keyboard: false, title: 'Pickup' }).addTo(layer);
    }
    if (delivery) {
      L.marker([delivery.lat, delivery.lng], { icon: stopIcon('drop'), keyboard: false, title: 'Delivery' }).addTo(layer);
    }
    if (truck) {
      L.marker([truck.lat, truck.lng], {
        icon: truckIcon(truck.heading_deg),
        keyboard: false,
        title: 'Truck',
        zIndexOffset: 1000
      }).addTo(layer);
    }

    if (!framedRef.current && (pickup || delivery || truck)) {
      framedRef.current = true;
      // Not animated: a map torn down mid-zoom (React's dev double mount) throws.
      frame(false, false);
    }
  }, [pickup, delivery, truck, trail, remaining, lane, nextStop]);

  return (
    <div className="lane-map-wrap">
      <div ref={mapElRef} className="lane-map trip-map" role="region" aria-label="Trip map" />
      <div className="trip-map-actions">
        <button type="button" className="btn ghost py-1 px-2 text-[0.7rem]" onClick={() => frame(true)} disabled={!truck}>
          Truck &amp; next stop
        </button>
        <button type="button" className="btn ghost py-1 px-2 text-[0.7rem]" onClick={() => frame(false)}>
          Whole trip
        </button>
      </div>
    </div>
  );
};
