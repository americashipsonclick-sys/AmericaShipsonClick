export type UserRole = 'driver' | 'shipper' | 'admin';
export type EquipmentType =
  | 'cargo_van'
  | 'bumper_pull'
  | 'gooseneck_hotshot'
  | 'gooseneck_cdl_40'
  | 'gooseneck_specialized'
  | 'car_carrier'
  | 'flatbed'
  | 'oversize_legal'
  | 'oversize_permitted'
  | 'dry_van'
  | 'reefer'
  | 'step_deck'
  | 'power_only';
export type LoadStatus = 'open' | 'booked' | 'in_transit' | 'delivered' | 'cancelled';
export type BookingStatus = 'active' | 'completed' | 'cancelled';

export interface PlatformConfig {
  factor_pct: number;
  broker_comparison_pct: number;
}

export interface RateCard {
  equipment_key: EquipmentType;
  label: string;
  cdl_required: boolean;
  rate_min_per_mile: number;
  rate_max_per_mile: number;
  base_rate_per_mile: number;
  short_haul_under_miles: number | null;
  short_haul_rate_min_per_mile: number | null;
  short_haul_rate_max_per_mile: number | null;
  short_haul_base_rate_per_mile: number | null;
  minimum_charge: number;
  short_haul_minimum_charge: number | null;
  deadhead_buffer_pct: number;
  express_surcharge_pct: number;
}

export interface AccessorialFee {
  code: string;
  label: string;
  amount: number;
  description?: string;
}

export interface RateCatalog {
  cards: RateCard[];
  accessorials: AccessorialFee[];
  default_demand_multiplier: number;
}

export interface QuoteBreakdown {
  equipment_key: string;
  label: string;
  miles: number;
  applied_rate_per_mile: number;
  short_haul: boolean;
  linehaul_raw: number;
  minimum_floor: number;
  minimum_applied: boolean;
  linehaul: number;
  deadhead_miles: number;
  deadhead_from_miles: number;
  deadhead_from_buffer: number;
  deadhead_amount: number;
  accessorials: { code: string; label: string; amount: number }[];
  accessorials_amount: number;
  demand_multiplier: number;
  express: boolean;
  express_surcharge_pct: number;
  after_demand: number;
  after_express: number;
  quoted_total: number;
  quoted_rate_per_mile: number;
}

export interface RateQuoteLog {
  id: string;
  equipment_key: EquipmentType;
  equipment_label?: string;
  load_id?: string;
  miles: number;
  quoted_total: number;
  quoted_rate_per_mile: number;
  posted_rate_per_mile: number;
  overridden: boolean;
  created_at: string;
}

export interface GeoPlace {
  city: string;
  state: string;
  lat: number;
  lng: number;
  label: string;
  street?: string;
  zip?: string;
  kind?: 'address' | 'street' | 'postcode' | 'city';
}

export interface GeoRoute {
  miles: number;
  geometry: [number, number][];
}

export interface User {
  id: string;
  email: string;
  role: UserRole;
  driverId?: string;
  shipperId?: string;
  name?: string;
}

export interface Load {
  id: string;
  shipper_id: string;
  shipper_name?: string;
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  origin_street?: string;
  origin_zip?: string;
  origin_address?: string;
  dest_street?: string;
  dest_zip?: string;
  dest_address?: string;
  origin_lat?: number;
  origin_lng?: number;
  dest_lat?: number;
  dest_lng?: number;
  miles: number;
  rate_per_mile: number;
  equipment_type: EquipmentType;
  pickup_date: string;
  weight_lbs?: number;
  notes?: string;
  same_day_funding_offered: boolean;
  status: LoadStatus;
  created_at: string;
  load_type?: 'full_truckload' | 'partial' | null;
  pickup_appt_start?: string | null;
  pickup_appt_end?: string | null;
  pickup_dock?: string | null;
  pickup_parking?: string | null;
  pickup_checkin?: string | null;
  delivery_date?: string | null;
  delivery_appt_start?: string | null;
  delivery_appt_end?: string | null;
  delivery_dock?: string | null;
  delivery_parking?: string | null;
  receiving_hours?: string | null;
  pallets?: number | null;
  commodity?: string | null;
  temperature_f?: number | null;
  hazmat?: boolean | null;
  requires_twic?: boolean;
  requires_team?: boolean;
  requires_load_bars?: boolean;
  payment_terms?: string | null;
  // GET /loads/:id only
  shipper_member_since?: string;
  shipper_loads_posted?: number;
  photos?: LoadPhoto[];
}

export interface LoadPhoto {
  id: string;
  caption: string | null;
  created_at: string;
}

export interface Booking {
  id: string;
  load_id: string;
  driver_id: string;
  booked_at: string;
  status: BookingStatus;
  pod_url?: string;
  delivered_at?: string;
}

export interface BookingWithLoad extends Booking {
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  origin_street?: string;
  origin_zip?: string;
  origin_address?: string;
  dest_street?: string;
  dest_zip?: string;
  dest_address?: string;
  miles: number;
  rate_per_mile: number;
  equipment_type: EquipmentType;
  pickup_date: string;
  same_day_funding_offered: boolean;
  load_status: LoadStatus;
  shipper_id: string;
  weight_lbs?: number;
  notes?: string;
}

export type TripPhase = 'to_pickup' | 'to_delivery' | 'delivered' | 'cancelled';
export type TripStop = 'pickup' | 'delivery';

/** One GPS fix from the driver's phone. */
export interface TrackPoint {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  recorded_at: string;
}

export interface TripEvent {
  event_type: string;
  occurred_at: string;
  notes: string | null;
  location_city: string | null;
  location_state: string | null;
}

/** GET /bookings/:id/tracking — one trip as the driver and the shipper see it. */
export interface TripTracking {
  booking: {
    id: string;
    load_id: string;
    status: BookingStatus;
    booked_at: string;
    picked_up_at: string | null;
    delivered_at: string | null;
    pod_attached: boolean;
  };
  load: {
    id: string;
    status: LoadStatus;
    origin_city: string;
    origin_state: string;
    origin_address: string | null;
    dest_city: string;
    dest_state: string;
    dest_address: string | null;
    pickup_date: string;
    delivery_date: string | null;
    miles: number;
    equipment_type: EquipmentType;
    reference_number: string | null;
    weight_lbs: number | null;
  };
  phase: TripPhase;
  stops: { pickup: { lat: number; lng: number } | null; delivery: { lat: number; lng: number } | null };
  last: TrackPoint | null;
  trail: [number, number][];
  remaining: { stop: TripStop; miles: number; minutes: number; geometry: [number, number][] } | null;
  lane: [number, number][] | null;
  events: TripEvent[];
}

export interface PublicLedgerItem {
  id: string;
  load_id: string;
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  equipment_type: EquipmentType;
  miles: number;
  rate_per_mile: number;
  gross_amount: number;
  fee_amount: number;
  fee_pct_applied: number;
  factor_cost: number;
  factored: boolean;
  net_amount: number;
  settled_at: string;
}

export interface SettlementTotals {
  count: number;
  miles: number;
  gross: number;
  fee: number;
  factor: number;
  net: number;
}

export interface AdminDriverDocument {
  id: string;
  doc_type: string;
  file_url: string;
  uploaded_at: string;
  review_status: string;
}

export interface AdminDriverEquipment {
  equipment_type: EquipmentType;
  trailer_length_ft: number;
}

export interface AdminDriver {
  id: string;
  full_name: string;
  email: string;
  phone?: string | null;
  home_base_city: string;
  home_base_state: string;
  cdl_number?: string | null;
  cdl_class?: string | null;
  dot_number?: string | null;
  mc_number?: string | null;
  verification_status: 'pending' | 'verified' | 'rejected';
  verified_at?: string | null;
  rejection_reason?: string | null;
  insurance_expires_at?: string | null;
  created_at: string;
  same_day_funding_opt_in: boolean;
  payout_on_file: boolean;
  equipment: AdminDriverEquipment[];
  documents: AdminDriverDocument[];
  booking_count: number;
  active_booking_count: number;
}

export interface AdminShipperLoad {
  id: string;
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  miles: number;
  rate_per_mile: number;
  equipment_type: EquipmentType;
  status: LoadStatus;
  pickup_date: string;
}

export interface AdminShipper {
  id: string;
  company_name: string;
  billing_email: string;
  email: string;
  phone?: string | null;
  created_at: string;
  load_count: number;
  open_load_count: number;
  recent_loads: AdminShipperLoad[];
}

export interface DriverOnboardInput {
  full_name: string;
  home_base_city: string;
  home_base_state: string;
  cdl_number?: string;
  cdl_class?: 'A' | 'B';
  dot_number?: string;
  mc_number?: string;
  equipment_type: EquipmentType;
  trailer_length_ft?: number;
  routing_number?: string;
  account_number?: string;
  same_day_funding_opt_in: boolean;
  cdl_photo_url?: string;
  dot_authority_url?: string;
  coi_url?: string;
}
