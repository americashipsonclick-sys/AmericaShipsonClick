import type { Load, RateCatalog } from '../types/api';

/** pickup_date and delivery_date are stored as YYYY-MM-DD; read them as local days. */
function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** "Nov 4" */
export function shortDay(value: string): string {
  const day = parseDay(value);
  return day ? day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : value;
}

/** "Wed, Nov 4, 2026" */
export function longDay(value: string): string {
  const day = parseDay(value);
  return day
    ? day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : value;
}

/** "Nov 2026" */
export function monthYear(value: string): string {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** "Nov 4, 7:42 AM" */
export function dayAndTime(value: string): string {
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function timeAgo(value: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(value).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** "08:00–12:00", or whichever end the shipper gave. */
export function appointment(start?: string | null, end?: string | null): string {
  if (start && end) return `${start}–${end}`;
  return start ? `from ${start}` : end ? `by ${end}` : '';
}

/** "Nov 4–6" across the pickups on the board; "Nov 30–Dec 2" over a month end. */
export function pickupRange(loads: Load[]): string {
  const days = loads.map((load) => load.pickup_date).filter((day) => parseDay(day)).sort();
  if (days.length === 0) return '';
  const first = shortDay(days[0]);
  const last = shortDay(days[days.length - 1]);
  if (first === last) return first;
  const [firstMonth] = first.split(' ');
  const [lastMonth, lastDay] = last.split(' ');
  return firstMonth === lastMonth ? `${first}–${lastDay}` : `${first}–${last}`;
}

export function equipmentLabel(load: Pick<Load, 'equipment_type'>, catalog?: RateCatalog): string {
  return catalog?.cards.find((card) => card.equipment_key === load.equipment_type)?.label
    || load.equipment_type.replaceAll('_', ' ');
}

export function loadTypeLabel(load: Pick<Load, 'load_type'>): string {
  if (load.load_type === 'full_truckload') return 'Full truckload';
  if (load.load_type === 'partial') return 'Partial';
  return '';
}

/** Only what the shipper actually requires. */
export function requirements(load: Pick<Load, 'requires_twic' | 'requires_team' | 'requires_load_bars'>): string {
  return [
    load.requires_twic && 'TWIC',
    load.requires_team && 'Team',
    load.requires_load_bars && 'Load bars'
  ].filter(Boolean).join(' · ');
}
