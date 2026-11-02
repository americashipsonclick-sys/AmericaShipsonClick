/**
 * Lane geocoding for Post Load. Nominatim (OSM) for US place lookup —
 * exact address, street, ZIP, or city — and OSRM for driving miles.
 * Browser clients cannot set Nominatim's required User-Agent, so the app
 * proxies these instead of calling them from the SPA.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = 'https://router.project-osrm.org';
const USER_AGENT = 'AmericaShipsOnClick/1.0 (https://www.americashipsonclick.com; freight lane geocode)';

export type GeoPlaceKind = 'address' | 'street' | 'postcode' | 'city';

export type GeoPlace = {
  city: string;
  state: string;
  lat: number;
  lng: number;
  label: string;
  street?: string;
  zip?: string;
  kind: GeoPlaceKind;
};

export type GeoRoute = {
  miles: number;
  /** Driving time at car speeds; a loaded truck runs somewhat slower. */
  minutes: number;
  geometry: [number, number][];
};

const STATE_BY_NAME: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY'
};

type NominatimAddress = Record<string, unknown>;

type NominatimHit = {
  lat?: string;
  lon?: string;
  class?: string;
  type?: string;
  addresstype?: string;
  display_name?: string;
  address?: NominatimAddress;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function looksLikeZip(q: string): boolean {
  return /^\d{5}(?:-\d{4})?$/.test(q.trim());
}

function usStateCode(address: NominatimAddress): string | null {
  const iso = address['ISO3166-2-lvl4'] ?? address['ISO3166-2-lvl3'];
  if (typeof iso === 'string' && iso.startsWith('US-') && iso.length === 5) {
    return iso.slice(3);
  }
  if (typeof address.state_code === 'string' && address.state_code.length === 2) {
    return address.state_code.toUpperCase();
  }
  if (typeof address.state === 'string') {
    const mapped = STATE_BY_NAME[address.state.toLowerCase()];
    if (mapped) return mapped;
    if (/^[A-Za-z]{2}$/.test(address.state)) return address.state.toUpperCase();
  }
  return null;
}

function cityFromAddress(address: NominatimAddress): string | null {
  const keys = ['city', 'town', 'village', 'hamlet', 'municipality', 'county'];
  for (const key of keys) {
    const value = text(address[key]);
    if (value) return value;
  }
  return null;
}

function zipFromAddress(address: NominatimAddress): string | undefined {
  const zip = text(address.postcode);
  const five = zip.match(/^(\d{5})/);
  return five ? five[1] : undefined;
}

function streetFromAddress(address: NominatimAddress): string | undefined {
  const road = text(address.road)
    || text(address.pedestrian)
    || text(address.residential)
    || text(address.street);
  if (!road) return undefined;
  const house = text(address.house_number);
  return house ? `${house} ${road}` : road;
}

function placeKind(
  hit: NominatimHit,
  address: NominatimAddress,
  street: string | undefined,
  preferPostcode: boolean
): GeoPlaceKind {
  const addresstype = text(hit.addresstype || hit.type).toLowerCase();
  const cls = text(hit.class).toLowerCase();
  if (text(address.house_number) || addresstype === 'house' || addresstype === 'building') {
    return 'address';
  }
  if (cls === 'highway' || addresstype === 'road' || addresstype === 'residential' || addresstype === 'pedestrian') {
    return 'street';
  }
  if (preferPostcode || addresstype === 'postcode' || addresstype === 'postal_code') {
    return 'postcode';
  }
  if (street && text(address.house_number)) return 'address';
  if (street) return 'street';
  return 'city';
}

export function formatPlaceLabel(parts: {
  city: string;
  state: string;
  street?: string;
  zip?: string;
}): string {
  const locality = parts.zip
    ? `${parts.city}, ${parts.state} ${parts.zip}`
    : `${parts.city}, ${parts.state}`;
  return parts.street ? `${parts.street}, ${locality}` : locality;
}

function placeFromNominatim(hit: NominatimHit, preferPostcode = false): GeoPlace | null {
  const address = hit.address;
  if (!address) return null;
  if (String(address.country_code || '').toLowerCase() !== 'us') return null;
  const state = usStateCode(address);
  const zip = zipFromAddress(address);
  const street = streetFromAddress(address);
  const city = cityFromAddress(address);
  if (!state || (!city && !zip)) return null;
  const cityName = city || 'Unincorporated';
  const lat = parseFloat(String(hit.lat ?? ''));
  const lng = parseFloat(String(hit.lon ?? ''));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const kind = placeKind(hit, address, street, preferPostcode);
  return {
    city: cityName,
    state,
    lat,
    lng,
    street,
    zip,
    kind,
    label: formatPlaceLabel({ city: cityName, state, street, zip })
  };
}

async function nominatimGet(url: URL): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    throw new Error(`Geocoder returned ${res.status}`);
  }
  return res.json();
}

function collectPlaces(data: unknown, preferPostcode: boolean): GeoPlace[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const places: GeoPlace[] = [];
  for (const hit of data) {
    const place = placeFromNominatim(hit as NominatimHit, preferPostcode);
    if (!place) continue;
    const key = place.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(place);
  }
  return places;
}

async function nominatimSearch(params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${NOMINATIM}/search`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('limit', '8');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return nominatimGet(url);
}

export async function searchPlaces(q: string): Promise<GeoPlace[]> {
  const trimmed = q.trim();
  if (looksLikeZip(trimmed)) {
    const zip = trimmed.slice(0, 5);
    const structured = collectPlaces(
      await nominatimSearch({ postalcode: zip, country: 'us' }),
      true
    );
    if (structured.length > 0) return structured;
    return collectPlaces(await nominatimSearch({ q: zip }), true);
  }

  return collectPlaces(await nominatimSearch({ q: trimmed }), false);
}

async function reverseAtZoom(lat: number, lng: number, zoom: number): Promise<GeoPlace | null> {
  const url = new URL(`${NOMINATIM}/reverse`);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('zoom', String(zoom));
  const data = await nominatimGet(url);
  return placeFromNominatim(data as NominatimHit);
}

export async function reversePlace(lat: number, lng: number): Promise<GeoPlace | null> {
  const street = await reverseAtZoom(lat, lng, 18);
  if (street) return street;
  return reverseAtZoom(lat, lng, 10);
}

function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const r = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export async function drivingRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): Promise<GeoRoute> {
  const path = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = new URL(`${OSRM}/route/v1/driving/${path}`);
  url.searchParams.set('overview', 'simplified');
  url.searchParams.set('geometries', 'geojson');

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Router returned ${res.status}`);
    const data = await res.json() as {
      code?: string;
      routes?: Array<{
        distance: number;
        duration: number;
        geometry?: { coordinates?: number[][] };
      }>;
    };
    const route = data.routes?.[0];
    if (data.code !== 'Ok' || !route) throw new Error('No driving route');
    const miles = Math.max(1, Math.round(route.distance / 1609.344));
    const geometry: [number, number][] = (route.geometry?.coordinates ?? []).map(
      ([lng, lat]) => [lat, lng] as [number, number]
    );
    return { miles, minutes: Math.round(route.duration / 60), geometry };
  } catch {
    // Highway circuity vs great-circle; used only if the public router is down.
    const miles = Math.max(1, Math.round(haversineMiles(from, to) * 1.18));
    return {
      miles,
      minutes: Math.round((miles / 50) * 60),
      geometry: [[from.lat, from.lng], [to.lat, to.lng]]
    };
  }
}
