import React, { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../lib/api';
import type { GeoPlace } from '../types/api';

type PickMode = 'origin' | 'dest';

const EMPTY_PLACES: GeoPlace[] = [];

interface LaneMapProps {
  origin: GeoPlace | null;
  dest: GeoPlace | null;
  savedPlaces?: GeoPlace[];
  onOriginChange: (place: GeoPlace) => void;
  onDestChange: (place: GeoPlace) => void;
  onMilesChange: (miles: number) => void;
}

function pinIcon(kind: PickMode): L.DivIcon {
  const letter = kind === 'origin' ? 'A' : 'B';
  const tone = kind === 'origin' ? 'origin' : 'dest';
  return L.divIcon({
    className: 'lane-pin',
    html: `<span class="lane-pin-dot ${tone}"><span class="lane-pin-letter">${letter}</span></span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -24]
  });
}

function kindLabel(kind?: GeoPlace['kind'], saved?: boolean): string {
  if (saved) return 'Your location';
  if (kind === 'address') return 'Address';
  if (kind === 'street') return 'Street';
  if (kind === 'postcode') return 'ZIP';
  return 'City';
}

function placeMatches(place: GeoPlace, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  return [
    place.label,
    place.city,
    place.state,
    place.street,
    place.zip
  ].some((part) => (part ?? '').toLowerCase().includes(needle));
}

function placeKey(place: GeoPlace): string {
  return `${place.label}|${place.lat.toFixed(5)}|${place.lng.toFixed(5)}`;
}

interface PlaceSearchProps {
  label: string;
  hint: string;
  placeholder: string;
  place: GeoPlace | null;
  savedPlaces: GeoPlace[];
  active: boolean;
  onActivate: () => void;
  onSelect: (place: GeoPlace) => void;
}

const PlaceSearch: React.FC<PlaceSearchProps> = ({
  label,
  hint,
  placeholder,
  place,
  savedPlaces,
  active,
  onActivate,
  onSelect
}) => {
  const [query, setQuery] = useState(place?.label ?? '');
  const [hits, setHits] = useState<GeoPlace[]>([]);
  const [savedHits, setSavedHits] = useState<GeoPlace[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    setQuery(place?.label ?? '');
  }, [place?.label]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q === place?.label) {
      setHits([]);
      setSavedHits([]);
      setSearching(false);
      return;
    }

    const matchedSaved = savedPlaces.filter((entry) => placeMatches(entry, q)).slice(0, 5);
    setSavedHits(matchedSaved);
    setOpen(true);

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.searchPlaces(q)
        .then((results) => {
          if (cancelled) return;
          const savedLabels = new Set(matchedSaved.map((entry) => entry.label.toLowerCase()));
          setHits(results.filter((entry) => !savedLabels.has(entry.label.toLowerCase())));
          setOpen(true);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, place?.label, savedPlaces]);

  const pick = (next: GeoPlace) => {
    setQuery(next.label);
    setHits([]);
    setSavedHits([]);
    setOpen(false);
    onSelect(next);
  };

  const showList = open && (savedHits.length > 0 || hits.length > 0);

  return (
    <div className={`lane-search ${active ? 'is-active' : ''}`}>
      <button type="button" className="lane-search-tab" onClick={onActivate}>
        <span className="lane-search-letter">{hint}</span>
        {label}
      </button>
      <div className="relative">
        <input
          type="text"
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          onFocus={onActivate}
          onChange={(e) => {
            onActivate();
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const first = savedHits[0] ?? hits[0];
              if (first) pick(first);
            }
          }}
          className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm"
        />
        {searching && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase tracking-wider text-[#5B6168]">
            …
          </span>
        )}
        {showList && (
          <ul className="lane-suggest" role="listbox">
            {savedHits.map((hit) => (
              <li key={`saved-${placeKey(hit)}`}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(hit)}>
                  {hit.label}
                  <span className="lane-suggest-meta">{kindLabel(hit.kind, true)}</span>
                </button>
              </li>
            ))}
            {hits.map((hit) => (
              <li key={placeKey(hit)}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(hit)}>
                  {hit.label}
                  <span className="lane-suggest-meta">{kindLabel(hit.kind)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export const LaneMap: React.FC<LaneMapProps> = ({
  origin,
  dest,
  savedPlaces = EMPTY_PLACES,
  onOriginChange,
  onDestChange,
  onMilesChange
}) => {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<{
    origin?: L.Marker;
    dest?: L.Marker;
    line?: L.Polyline;
  }>({});
  const pickModeRef = useRef<PickMode>('origin');
  const originCbRef = useRef(onOriginChange);
  const destCbRef = useRef(onDestChange);
  const milesCbRef = useRef(onMilesChange);

  const [pickMode, setPickMode] = useState<PickMode>(origin && !dest ? 'dest' : 'origin');
  const [locating, setLocating] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<[number, number][]>([]);

  pickModeRef.current = pickMode;
  originCbRef.current = onOriginChange;
  destCbRef.current = onDestChange;
  milesCbRef.current = onMilesChange;

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

    map.on('click', (event: L.LeafletMouseEvent) => {
      const mode = pickModeRef.current;
      setLocating(true);
      setMapError(null);
      api.reverseGeocode(event.latlng.lat, event.latlng.lng)
        .then((place) => {
          if (mode === 'origin') {
            originCbRef.current(place);
            setPickMode('dest');
          } else {
            destCbRef.current(place);
          }
        })
        .catch((err: Error) => {
          setMapError(err.message || 'Drop the pin on a US address or city.');
        })
        .finally(() => setLocating(false));
    });

    mapRef.current = map;
    const sizeTimer = window.setTimeout(() => map.invalidateSize(), 80);

    return () => {
      window.clearTimeout(sizeTimer);
      map.remove();
      mapRef.current = null;
      layersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!origin || !dest) {
      setGeometry([]);
      setMeasuring(false);
      return;
    }

    let cancelled = false;
    setMeasuring(true);
    setMapError(null);
    api.drivingRoute(origin, dest)
      .then((route) => {
        if (cancelled) return;
        setGeometry(route.geometry);
        milesCbRef.current(route.miles);
      })
      .catch((err: Error) => {
        if (!cancelled) setMapError(err.message || 'Could not measure that lane.');
      })
      .finally(() => {
        if (!cancelled) setMeasuring(false);
      });

    return () => {
      cancelled = true;
    };
  }, [origin, dest]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layers = layersRef.current;

    const upsert = (kind: PickMode, place: GeoPlace | null) => {
      const existing = layers[kind];
      if (!place) {
        if (existing) {
          map.removeLayer(existing);
          layers[kind] = undefined;
        }
        return;
      }
      const latlng: L.LatLngExpression = [place.lat, place.lng];
      if (existing) {
        existing.setLatLng(latlng);
        existing.setPopupContent(place.label);
      } else {
        layers[kind] = L.marker(latlng, { icon: pinIcon(kind), keyboard: false })
          .addTo(map)
          .bindPopup(place.label);
      }
    };

    upsert('origin', origin);
    upsert('dest', dest);

    if (layers.line) {
      map.removeLayer(layers.line);
      layers.line = undefined;
    }

    const linePoints = geometry.length >= 2
      ? geometry
      : origin && dest
        ? [[origin.lat, origin.lng], [dest.lat, dest.lng]] as [number, number][]
        : [];

    if (linePoints.length >= 2) {
      layers.line = L.polyline(linePoints, {
        color: '#0F5132',
        weight: 3,
        opacity: 0.85
      }).addTo(map);
      map.fitBounds(layers.line.getBounds(), { padding: [36, 36], maxZoom: 14 });
    } else if (origin) {
      map.setView([origin.lat, origin.lng], origin.street || origin.zip ? 15 : 10);
    }
  }, [origin, dest, geometry]);

  const status = locating
    ? 'Locating address…'
    : measuring
      ? 'Measuring driving miles…'
      : pickMode === 'origin'
        ? 'Click the map to drop pickup (A), or search an address, street, city, or ZIP.'
        : 'Click the map to drop destination (B), or search an address, street, city, or ZIP.';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PlaceSearch
          label="Pickup location"
          hint="A"
          placeholder="Address, street, city, or ZIP"
          place={origin}
          savedPlaces={savedPlaces}
          active={pickMode === 'origin'}
          onActivate={() => setPickMode('origin')}
          onSelect={(place) => {
            onOriginChange(place);
            setPickMode('dest');
          }}
        />
        <PlaceSearch
          label="Drop location"
          hint="B"
          placeholder="Address, street, city, or ZIP"
          place={dest}
          savedPlaces={savedPlaces}
          active={pickMode === 'dest'}
          onActivate={() => setPickMode('dest')}
          onSelect={onDestChange}
        />
      </div>

      <div className="lane-map-wrap">
        <div ref={mapElRef} className="lane-map" role="application" aria-label="Lane map" />
        <p className="lane-map-status">{status}</p>
      </div>

      {mapError && (
        <p className="font-mono text-xs text-[#8C2F1B]">{mapError}</p>
      )}
    </div>
  );
};
