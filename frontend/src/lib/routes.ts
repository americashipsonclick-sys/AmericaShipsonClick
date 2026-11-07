import type { MouseEvent } from 'react';
import type { User, UserRole } from '../types/api';

/** Linkable paths. Keep frontend/public/sitemap.xml in step with the indexed ones. */
export const TAB_PATHS: Record<string, string> = {
  home: '/',
  loads: '/loads',
  books: '/books',
  driver: '/drive',
  shipper: '/post-load',
  dashboard: '/dashboard',
  admin: '/admin',
  trip: '/trip',
  privacy: '/privacy',
  terms: '/terms'
};

const PATH_TABS: Record<string, string> = Object.fromEntries(
  Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab])
);

/** Unknown paths stay unknown so the address bar can show a real 404. */
export function tabForPath(pathname: string): string {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PATH_TABS[normalized] ?? 'notfound';
}

export function pathFor(tab: string): string {
  return TAB_PATHS[tab] ?? '/';
}

/** The trip page names its booking in the query: /trip?booking=BK-... */
export function tripPath(bookingId: string): string {
  return `${TAB_PATHS.trip}?booking=${encodeURIComponent(bookingId)}`;
}

export function tripBookingFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('booking');
}

/**
 * Tabs only some roles may see. Admins keep every tab because the API lets
 * them post and book too. Tabs not listed here are open to everyone.
 */
export const TAB_ROLES: Record<string, UserRole[]> = {
  loads: ['driver', 'admin'],
  shipper: ['shipper', 'admin'],
  admin: ['admin'],
  trip: ['driver', 'shipper', 'admin']
};

export function canSeeTab(tab: string, user: User | null): boolean {
  const roles = TAB_ROLES[tab];
  if (!roles) return true;
  return !!user && roles.includes(user.role);
}

/** In-app navigation for real links. Modified clicks still open a new tab. */
export function followTabLink(event: MouseEvent<HTMLAnchorElement>, go: (tab: string) => void, tab: string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  go(tab);
}

export const SITE_NAME = 'America Ships On Click';

export const PAGE_META: Record<string, { title: string; description: string; path: string; robots: string }> = {
  home: {
    title: 'America Ships On Click — Freight Load Board & Open Books Ledger',
    description: 'No-broker freight load board with a public settlement ledger. Shippers post loads, carriers book direct, and every settlement is on the books.',
    path: '/',
    robots: 'index,follow'
  },
  loads: {
    title: 'Find Loads — America Ships On Click',
    description: 'Open freight on the America Ships On Click board. Filter by lane and equipment, then book direct with the shipper.',
    path: '/loads',
    robots: 'noindex,nofollow'
  },
  books: {
    title: 'Open Books Ledger — America Ships On Click',
    description: 'Public settlement ledger. Every settled load shows miles, rate, and what the carrier was paid.',
    path: '/books',
    robots: 'index,follow'
  },
  driver: {
    title: 'Drive With Us — America Ships On Click',
    description: 'Carrier onboarding. Submit your CDL, operating authority, and insurance, then book loads on the open board.',
    path: '/drive',
    robots: 'index,follow'
  },
  shipper: {
    title: 'Post a Load — America Ships On Click',
    description: 'Post a load with a live lane quote. The full price is shown before the load goes on the board.',
    path: '/post-load',
    robots: 'noindex,nofollow'
  },
  dashboard: {
    title: 'Dashboard — America Ships On Click',
    description: 'Your loads, bookings, and settlements on America Ships On Click.',
    path: '/dashboard',
    robots: 'noindex,nofollow'
  },
  admin: {
    title: 'Admin — America Ships On Click',
    description: 'Operator console for America Ships On Click.',
    path: '/admin',
    robots: 'noindex,nofollow'
  },
  trip: {
    title: 'Trip — America Ships On Click',
    description: 'Live position, route, and timeline for a booked load.',
    path: '/trip',
    robots: 'noindex,nofollow'
  },
  privacy: {
    title: 'Privacy Policy — America Ships On Click',
    description: 'What America Ships On Click collects, what stays public on the ledger, and how optional page counts work.',
    path: '/privacy',
    robots: 'index,follow'
  },
  terms: {
    title: 'Terms of Use — America Ships On Click',
    description: 'Operating terms for the America Ships On Click load board: accounts, posted loads, fees, and the public ledger.',
    path: '/terms',
    robots: 'index,follow'
  },
  notfound: {
    title: 'Page not found — America Ships On Click',
    description: 'That address is not on America Ships On Click.',
    path: '/',
    robots: 'noindex,nofollow'
  }
};

export function applyPageMeta(tab: string) {
  const meta = PAGE_META[tab] ?? PAGE_META.notfound;
  document.title = meta.title;
  setNamedMeta('description', meta.description);
  setNamedMeta('robots', meta.robots);
  setNamedMeta('og:title', meta.title, 'property');
  setNamedMeta('og:description', meta.description, 'property');
  const origin = window.location.origin;
  const url = tab === 'notfound' ? window.location.href : origin + meta.path;
  setNamedMeta('og:url', url, 'property');
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical) canonical.href = tab === 'notfound' ? origin + '/' : origin + meta.path;
}

function setNamedMeta(name: string, content: string, attr: 'name' | 'property' = 'name') {
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.content = content;
}
