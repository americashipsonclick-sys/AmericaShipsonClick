import {
  PlatformConfig,
  GeoPlace,
  GeoRoute,
  Load,
  Booking,
  BookingWithLoad,
  PublicLedgerItem,
  SettlementTotals,
  DriverOnboardInput,
  User,
  RateCatalog,
  QuoteBreakdown,
  RateCard,
  RateQuoteLog,
  AdminDriver,
  AdminShipper,
  TrackPoint,
  TripTracking
} from '../types/api';

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/api';

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('americaships_jwt');
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorMsg = `API Error ${res.status}`;
    try {
      const data = await res.json();
      if (data.error) errorMsg = data.error;
    } catch {
      // ignore JSON parse error
    }
    throw new Error(errorMsg);
  }
  return res.json();
}

export const api = {
  // Config
  async getRates(): Promise<RateCatalog> {
    const res = await fetch(`${API_BASE}/rates`);
    return handleResponse<RateCatalog>(res);
  },

  async previewQuote(params: {
    equipment_key: string;
    miles: number;
    deadhead_miles?: number;
    demand_multiplier?: number;
    express?: boolean;
    accessorials?: string[];
  }): Promise<QuoteBreakdown> {
    const q = new URLSearchParams({
      equipment_key: params.equipment_key,
      miles: String(params.miles),
      deadhead_miles: String(params.deadhead_miles ?? 0),
      express: params.express ? 'true' : 'false'
    });
    if (params.demand_multiplier != null) q.set('demand_multiplier', String(params.demand_multiplier));
    if (params.accessorials?.length) q.set('accessorials', params.accessorials.join(','));
    const res = await fetch(`${API_BASE}/quotes/preview?${q.toString()}`);
    const data = await handleResponse<{ quote: QuoteBreakdown }>(res);
    return data.quote;
  },

  async patchRateCard(key: string, body: Partial<RateCard>): Promise<RateCard> {
    const res = await fetch(`${API_BASE}/admin/rate-cards/${key}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body)
    });
    const data = await handleResponse<{ card: RateCard }>(res);
    return data.card;
  },

  async postDiesel(dollars_per_gallon: number): Promise<{ diesel_ppg: number }> {
    const res = await fetch(`${API_BASE}/admin/diesel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ dollars_per_gallon })
    });
    return handleResponse<{ diesel_ppg: number }>(res);
  },

  async patchAccessorial(code: string, amount: number): Promise<void> {
    const res = await fetch(`${API_BASE}/admin/accessorials/${code}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ amount })
    });
    await handleResponse(res);
  },

  async getQuoteLog(): Promise<RateQuoteLog[]> {
    const res = await fetch(`${API_BASE}/admin/quotes`, {
      headers: getAuthHeaders()
    });
    const data = await handleResponse<{ quotes: RateQuoteLog[] }>(res);
    return data.quotes;
  },

  async getConfig(): Promise<PlatformConfig> {
    const res = await fetch(`${API_BASE}/config`);
    return handleResponse<PlatformConfig>(res);
  },

  async searchPlaces(q: string): Promise<GeoPlace[]> {
    const params = new URLSearchParams({ q });
    const res = await fetch(`${API_BASE}/geo/search?${params.toString()}`);
    const data = await handleResponse<{ results: GeoPlace[] }>(res);
    return data.results;
  },

  async getShipperLocations(): Promise<GeoPlace[]> {
    const res = await fetch(`${API_BASE}/shipper/locations`, {
      headers: getAuthHeaders()
    });
    const data = await handleResponse<{ locations: GeoPlace[] }>(res);
    return data.locations;
  },

  async reverseGeocode(lat: number, lng: number): Promise<GeoPlace> {
    const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    const res = await fetch(`${API_BASE}/geo/reverse?${params.toString()}`);
    const data = await handleResponse<{ place: GeoPlace }>(res);
    return data.place;
  },

  async drivingRoute(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number }
  ): Promise<GeoRoute> {
    const params = new URLSearchParams({
      fromLat: String(from.lat),
      fromLng: String(from.lng),
      toLat: String(to.lat),
      toLng: String(to.lng)
    });
    const res = await fetch(`${API_BASE}/geo/route?${params.toString()}`);
    return handleResponse<GeoRoute>(res);
  },

  // Auth
  async login(email: string, password: string): Promise<{ token: string; user: User }> {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await handleResponse<{ token: string; user: User }>(res);
    localStorage.setItem('americaships_jwt', data.token);
    return data;
  },

  async signup(data: any): Promise<{ token: string; user: User }> {
    const res = await fetch(`${API_BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await handleResponse<{ token: string; user: User }>(res);
    localStorage.setItem('americaships_jwt', result.token);
    return result;
  },

  async getMe(): Promise<{ user: User; profile: any }> {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: getAuthHeaders()
    });
    return handleResponse<{ user: User; profile: any }>(res);
  },

  logout() {
    localStorage.removeItem('americaships_jwt');
  },

  // Loads
  async getLoads(filters?: { origin?: string; destination?: string; equipment?: string; minRate?: number; status?: string }): Promise<Load[]> {
    const params = new URLSearchParams();
    if (filters?.origin) params.set('origin', filters.origin);
    if (filters?.destination) params.set('destination', filters.destination);
    if (filters?.equipment) params.set('equipment', filters.equipment);
    if (filters?.minRate) params.set('minRate', filters.minRate.toString());
    if (filters?.status) params.set('status', filters.status);

    const res = await fetch(`${API_BASE}/loads?${params.toString()}`, {
      headers: getAuthHeaders()
    });
    const data = await handleResponse<{ loads: Load[] }>(res);
    return data.loads;
  },

  /** The signed-in shipper's own loads, every status. */
  async getMyLoads(): Promise<Load[]> {
    const res = await fetch(`${API_BASE}/shipper/loads`, {
      headers: getAuthHeaders()
    });
    const data = await handleResponse<{ loads: Load[] }>(res);
    return data.loads;
  },

  async getLoad(id: string): Promise<Load> {
    const res = await fetch(`${API_BASE}/loads/${id}`, {
      headers: getAuthHeaders()
    });
    return handleResponse<Load>(res);
  },

  async createLoad(loadData: Partial<Load> & {
    deadhead_miles?: number;
    demand_multiplier?: number;
    express?: boolean;
    accessorial_codes?: string[];
  }): Promise<Load> {
    const res = await fetch(`${API_BASE}/loads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(loadData)
    });
    return handleResponse<Load>(res);
  },

  // Bookings
  async bookLoad(load_id: string): Promise<Booking> {
    const res = await fetch(`${API_BASE}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ load_id })
    });
    return handleResponse<Booking>(res);
  },

  async getBookings(): Promise<BookingWithLoad[]> {
    const res = await fetch(`${API_BASE}/bookings`, {
      headers: getAuthHeaders()
    });
    const data = await handleResponse<{ bookings: BookingWithLoad[] }>(res);
    return data.bookings;
  },

  async uploadPod(booking_id: string, pod_url: string): Promise<Booking> {
    const res = await fetch(`${API_BASE}/bookings/${booking_id}/pod`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ pod_url })
    });
    return handleResponse<Booking>(res);
  },

  async completeBooking(booking_id: string): Promise<{ message: string; settlement: PublicLedgerItem }> {
    const res = await fetch(`${API_BASE}/bookings/${booking_id}/complete`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
    });
    return handleResponse<{ message: string; settlement: PublicLedgerItem }>(res);
  },

  // Live tracking
  async getTripTracking(booking_id: string): Promise<TripTracking> {
    const res = await fetch(`${API_BASE}/bookings/${encodeURIComponent(booking_id)}/tracking`, {
      headers: getAuthHeaders()
    });
    return handleResponse<TripTracking>(res);
  },

  async markPickedUp(booking_id: string): Promise<Booking> {
    const res = await fetch(`${API_BASE}/bookings/${encodeURIComponent(booking_id)}/pickup`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    return handleResponse<Booking>(res);
  },

  /** `stopped` means the trip is over (or not this driver's), so the phone should stop sending. */
  async sendLocations(booking_id: string, points: TrackPoint[]): Promise<{ accepted: number; stopped: boolean }> {
    const res = await fetch(`${API_BASE}/bookings/${encodeURIComponent(booking_id)}/locations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ points })
    });
    if (res.status === 409 || res.status === 404) return { accepted: 0, stopped: true };
    const data = await handleResponse<{ accepted: number }>(res);
    return { accepted: data.accepted, stopped: false };
  },

  // Settlements
  async getSettlements(limit = 50, page = 1): Promise<PublicLedgerItem[]> {
    const res = await fetch(`${API_BASE}/settlements?limit=${limit}&page=${page}`);
    const data = await handleResponse<{ settlements: PublicLedgerItem[] }>(res);
    return data.settlements;
  },

  async getSettlementTotals(): Promise<SettlementTotals> {
    const res = await fetch(`${API_BASE}/settlements/aggregate`);
    return handleResponse<SettlementTotals>(res);
  },

  // Driver Onboarding
  async onboardDriver(data: DriverOnboardInput): Promise<{ message: string; token: string; driverId: string }> {
    const res = await fetch(`${API_BASE}/drivers/onboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(data)
    });
    const result = await handleResponse<{ message: string; token: string; driverId: string }>(res);
    if (result.token) localStorage.setItem('americaships_jwt', result.token);
    return result;
  },

  // Upload file
  async uploadFile(file: File): Promise<{ file_url: string; filename: string }> {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`${API_BASE}/uploads/file`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData
    });
    return handleResponse<{ file_url: string; filename: string }>(res);
  },

  // Admin
  async getAdminDirectory(): Promise<{ drivers: AdminDriver[]; shippers: AdminShipper[] }> {
    const res = await fetch(`${API_BASE}/admin/directory`, {
      headers: getAuthHeaders()
    });
    return handleResponse<{ drivers: AdminDriver[]; shippers: AdminShipper[] }>(res);
  },

  async verifyDriver(id: string, status: 'verified' | 'rejected' | 'pending', rejection_reason?: string): Promise<void> {
    const res = await fetch(`${API_BASE}/admin/drivers/${id}/verify`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ status, rejection_reason })
    });
    await handleResponse<{ success: boolean }>(res);
  },

  async getAdminLedger(): Promise<any[]> {
    const res = await fetch(`${API_BASE}/admin/ledger`, {
      headers: getAuthHeaders()
    });
    const data = await handleResponse<{ ledger: any[] }>(res);
    return data.ledger;
  },

  async downloadAdminExport(): Promise<void> {
    const res = await fetch(`${API_BASE}/admin/export`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) {
      let errorMsg = `API Error ${res.status}`;
      try {
        const data = await res.json();
        if (data.error) errorMsg = data.error;
      } catch {
        // ignore JSON parse error
      }
      throw new Error(errorMsg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'open-books-ledger-export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
};
