/**
 * Every US city and ZIP, searched in memory so Post Load can suggest places
 * as the shipper types. Nominatim matches whole words only and asks not to be
 * used for autocomplete, so it is kept for street addresses.
 */
import zipcodes from 'zipcodes';
import { formatPlaceLabel, STATE_BY_NAME, type GeoPlace } from './geo';

type City = {
  city: string;
  state: string;
  lat: number;
  lng: number;
  /** ZIPs that serve the city: a stand-in for size, so Atlanta, GA ranks above Atlanta, NE. */
  zipCount: number;
  key: string;
  words: string[];
};

type Zip = { zip: string; city: string; state: string; lat: number; lng: number };

const LIMIT = 8;

// Built on first search (geo.ts imports this file, so nothing here runs at load).
let index: { cities: City[]; zips: Zip[]; stateCodes: Set<string> } | null = null;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[.']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildIndex() {
  const stateCodes = new Set(Object.values(STATE_BY_NAME));
  const byCity = new Map<string, { city: string; state: string; lat: number; lng: number; n: number }>();
  const zips: Zip[] = [];
  for (const record of Object.values(zipcodes.codes)) {
    if (record.country !== 'US' || !stateCodes.has(record.state)) continue;
    const city = record.city
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase());
    zips.push({ zip: record.zip, city, state: record.state, lat: record.latitude, lng: record.longitude });
    const id = `${city}|${record.state}`;
    const entry = byCity.get(id);
    if (entry) {
      entry.lat += record.latitude;
      entry.lng += record.longitude;
      entry.n += 1;
    } else {
      byCity.set(id, { city, state: record.state, lat: record.latitude, lng: record.longitude, n: 1 });
    }
  }
  const cities: City[] = [...byCity.values()].map((entry) => {
    const key = normalize(entry.city);
    return {
      city: entry.city,
      state: entry.state,
      lat: entry.lat / entry.n,
      lng: entry.lng / entry.n,
      zipCount: entry.n,
      key,
      words: key.split(' ')
    };
  });
  cities.sort((a, b) => b.zipCount - a.zipCount);
  zips.sort((a, b) => a.zip.localeCompare(b.zip));
  return { cities, zips, stateCodes };
}

function getIndex() {
  if (!index) index = buildIndex();
  return index;
}

/** Splits "atlanta ga" or "atlanta, georgia" into the city part and a state code. */
function splitState(q: string, stateCodes: Set<string>): { cityPart: string; state: string | null } {
  const norm = normalize(q);
  const fullName = Object.keys(STATE_BY_NAME)
    .filter((name) => norm === name || norm.endsWith(` ${name}`))
    .sort((a, b) => b.length - a.length)[0];
  if (fullName) {
    return { cityPart: norm.slice(0, norm.length - fullName.length).trim(), state: STATE_BY_NAME[fullName] };
  }
  const last = norm.split(' ').pop() ?? '';
  // A bare two-letter word only counts as a state after a city ("dallas tx"), or with a comma ("ga" alone stays a prefix).
  if (last.length === 2 && stateCodes.has(last.toUpperCase()) && (norm.includes(' ') || q.includes(','))) {
    return { cityPart: norm.slice(0, -2).trim(), state: last.toUpperCase() };
  }
  return { cityPart: norm, state: null };
}

function cityPlace(city: City): GeoPlace {
  return {
    city: city.city,
    state: city.state,
    lat: city.lat,
    lng: city.lng,
    kind: 'city',
    label: formatPlaceLabel({ city: city.city, state: city.state })
  };
}

function zipPlace(entry: Zip): GeoPlace {
  return {
    city: entry.city,
    state: entry.state,
    lat: entry.lat,
    lng: entry.lng,
    zip: entry.zip,
    kind: 'postcode',
    label: formatPlaceLabel({ city: entry.city, state: entry.state, zip: entry.zip })
  };
}

export function searchUsPlaces(q: string): GeoPlace[] {
  const { cities, zips, stateCodes } = getIndex();
  const trimmed = q.trim();

  const digits = trimmed.match(/^(\d{3,5})(?:-\d{0,4})?$/);
  if (digits) {
    return zips.filter((entry) => entry.zip.startsWith(digits[1])).slice(0, LIMIT).map(zipPlace);
  }

  const { cityPart, state } = splitState(trimmed, stateCodes);
  const inState = state ? cities.filter((city) => city.state === state) : cities;
  if (!cityPart) return inState.slice(0, LIMIT).map(cityPlace);

  // Exact name, then name starts with the text, then a later word does ("york" → New York); biggest first in each.
  const exact: City[] = [];
  const prefix: City[] = [];
  const word: City[] = [];
  for (const city of inState) {
    if (city.key === cityPart) exact.push(city);
    else if (city.key.startsWith(cityPart)) prefix.push(city);
    else if (city.words.some((w, i) => i > 0 && city.words.slice(i).join(' ').startsWith(cityPart))) word.push(city);
    if (exact.length + prefix.length >= LIMIT * 4) break;
  }
  return [...exact, ...prefix, ...word].slice(0, LIMIT).map(cityPlace);
}
