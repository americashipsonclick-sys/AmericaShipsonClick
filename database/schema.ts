export type UserRole = 'driver' | 'shipper' | 'admin';
export type VerificationStatus = 'pending' | 'verified' | 'rejected';
export type CdlClass = 'A' | 'B';
export type DocType = 'cdl_photo' | 'dot_authority' | 'coi' | 'pod';
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
export type LoadEventType =
  | 'posted' | 'updated' | 'booked' | 'picked_up' | 'in_transit' | 'delivered'
  | 'settled' | 'cancelled' | 'offer_made' | 'offer_accepted' | 'offer_declined'
  | 'offer_withdrawn' | 'document_uploaded' | 'disputed' | 'dispute_resolved' | 'note'
  | 'arrived_pickup' | 'arrived_delivery';
export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired';
export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'rejected';
export type DisputeCategory = 'rate' | 'miles' | 'detention' | 'damage' | 'fee' | 'other';
export type MembershipStatus = 'active' | 'canceled' | 'expired';
export type EpochStatus = 'open' | 'closed';
export type ReserveSource = 'settlement' | 'on_chain' | 'manual';
export type PayoutStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';
export type ChainContractName = 'asoc_token' | 'usdc' | 'payout_relayer';

export interface User {
  id: string;
  role: UserRole;
  email: string;
  phone?: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface DriverProfile {
  id: string;
  user_id: string;
  full_name: string;
  home_base_city: string;
  home_base_state: string;
  cdl_number?: string;
  cdl_class?: CdlClass;
  dot_number?: string;
  mc_number?: string;
  verification_status: VerificationStatus;
  verified_at?: string;
  verified_by?: string;
  rejection_reason?: string;
  insurance_expires_at?: string;
  created_at: string;
}

export interface DriverDocument {
  id: string;
  driver_id: string;
  doc_type: DocType;
  file_url: string;
  uploaded_at: string;
  verified: boolean;
  review_status: VerificationStatus;
  reviewed_at?: string;
  reviewed_by?: string;
  review_notes?: string;
  expires_at?: string;
}

export interface DriverEquipment {
  id: string;
  driver_id: string;
  equipment_type: EquipmentType;
  trailer_length_ft: number;
}

export interface DriverPaymentAccount {
  id: string;
  driver_id: string;
  payment_processor: string;
  processor_account_id: string;
  same_day_funding_opt_in: boolean;
  created_at: string;
}

export interface ShipperProfile {
  id: string;
  user_id: string;
  company_name: string;
  billing_email: string;
  created_at: string;
}

export interface Load {
  id: string;
  shipper_id: string;
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  origin_lat?: number;
  origin_lng?: number;
  dest_lat?: number;
  dest_lng?: number;
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
  delivery_date?: string;
  commodity?: string;
  reference_number?: string;
  weight_lbs?: number;
  notes?: string;
  same_day_funding_offered: boolean;
  status: LoadStatus;
  cancelled_at?: string;
  cancellation_reason?: string;
  created_at: string;
  updated_at?: string;
  load_type?: 'full_truckload' | 'partial';
  pickup_appt_start?: string;
  pickup_appt_end?: string;
  pickup_dock?: string;
  pickup_parking?: string;
  pickup_checkin?: string;
  delivery_appt_start?: string;
  delivery_appt_end?: string;
  delivery_dock?: string;
  delivery_parking?: string;
  receiving_hours?: string;
  pallets?: number;
  temperature_f?: number;
  hazmat?: boolean;
  requires_twic: boolean;
  requires_team: boolean;
  requires_load_bars: boolean;
  payment_terms?: string;
}

export interface LoadPhoto {
  id: string;
  load_id: string;
  file_id: string;
  caption?: string;
  uploaded_by?: string;
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
  picked_up_at?: string;
  cancelled_at?: string;
  cancellation_reason?: string;
  cancelled_by?: string;
  agreed_rate_per_mile?: number;
}

/** One GPS fix from the booked driver's phone, accepted only while the trip is active. */
export interface BookingLocation {
  booking_id: string;
  recorded_at: string;
  lat: number;
  lng: number;
  accuracy_m?: number;
  speed_mps?: number;
  heading_deg?: number;
  received_at: string;
}

export interface Settlement {
  id: string;
  booking_id: string;
  load_id: string;
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

export interface PlatformConfig {
  factor_pct: number;
  broker_comparison_pct: number;
  reserve_pct?: number;
  holder_slice_of_reserve?: number;
  regular_weight?: number;
  premium_weight?: number;
  sell_lock_days?: number;
  base_chain_id?: number;
}

export interface LoadEvent {
  id: string;
  load_id: string;
  booking_id?: string;
  event_type: LoadEventType;
  actor_id?: string;
  actor_role?: string;
  from_status?: string;
  to_status?: string;
  notes?: string;
  location_city?: string;
  location_state?: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

export interface LoadOffer {
  id: string;
  load_id: string;
  driver_id: string;
  offered_rate_per_mile: number;
  message?: string;
  status: OfferStatus;
  expires_at: string;
  created_at: string;
  responded_at?: string;
  responded_by?: string;
  response_note?: string;
}

export interface Rating {
  id: string;
  booking_id: string;
  load_id: string;
  rater_user_id: string;
  rater_role: 'driver' | 'shipper';
  subject_driver_id?: string;
  subject_shipper_id?: string;
  score: number;
  communication_score?: number;
  on_time?: boolean;
  comment?: string;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  load_id?: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  read_at?: string;
  created_at: string;
}

export interface NotificationPreference {
  user_id: string;
  booking_alerts: boolean;
  offer_alerts: boolean;
  settlement_alerts: boolean;
  verification_alerts: boolean;
  dispute_alerts: boolean;
  updated_at: string;
}

export interface VerificationReview {
  id: string;
  driver_id: string;
  document_id?: string;
  reviewer_user_id?: string;
  decision: VerificationStatus;
  notes?: string;
  created_at: string;
}

export interface SettlementDispute {
  id: string;
  settlement_id: string;
  load_id: string;
  opened_by_user_id: string;
  opened_by_role: UserRole;
  category: DisputeCategory;
  reason: string;
  claimed_amount?: number;
  status: DisputeStatus;
  resolution_note?: string;
  resolved_at?: string;
  resolved_by?: string;
  created_at: string;
  updated_at: string;
}

export interface SettlementAdjustment {
  id: string;
  settlement_id: string;
  dispute_id?: string;
  amount: number;
  reason: string;
  created_by?: string;
  created_at: string;
}

export interface ChainContract {
  id: string;
  chain_id: number;
  name: ChainContractName;
  address: string;
  created_at: string;
}

export interface Wallet {
  id: string;
  user_id?: string;
  chain_id: number;
  address: string;
  created_at: string;
  linked_at?: string;
}

export interface WebhookReceipt {
  id: string;
  source: string;
  delivery_id: string;
  payload_hash: string;
  received_at: string;
}

export interface ContractEvent {
  id: string;
  webhook_receipt_id?: string;
  chain_id: number;
  contract_address: string;
  event_name: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: string;
  wallet_address?: string;
  payload: Record<string, unknown>;
  ingested_at: string;
}

export interface TokenBuy {
  id: string;
  wallet_id: string;
  amount: number;
  tx_hash: string;
  log_index: number;
  bought_at: string;
  lock_until: string;
}

export interface TokenPosition {
  wallet_id: string;
  staked_balance: number;
  first_buy_at?: string;
  sell_locked_until?: string;
  updated_at: string;
}

export interface AppMembership {
  id: string;
  user_id: string;
  plan: 'premium';
  status: MembershipStatus;
  started_at: string;
  expires_at?: string;
  canceled_at?: string;
  processor?: string;
  processor_subscription_id?: string;
}

export interface PremiumAttestation {
  id: string;
  user_id: string;
  membership_id: string;
  wallet_id: string;
  attested_at: string;
  revoked_at?: string;
  on_chain_tx?: string;
}

export interface HourlyEpoch {
  id: string;
  epoch_hour: string;
  holder_pool: number;
  total_weight?: number;
  haircut_ratio?: number;
  status: EpochStatus;
  closed_at?: string;
}

export interface TransactionReserve {
  id: string;
  source: ReserveSource;
  source_id?: string;
  volume: number;
  reserve_amount: number;
  holder_slice: number;
  epoch_id: string;
  credited_at: string;
}

export interface HourlyClaim {
  id: string;
  epoch_id: string;
  wallet_id: string;
  staked_balance: number;
  weight_multiplier: 1 | 5;
  weight: number;
  premium_attestation_id?: string;
  entitled_before_haircut: number;
  haircut_ratio: number;
  paid_amount: number;
  tx_hash?: string;
  claimed_at: string;
}

export interface DriverPayout {
  id: string;
  driver_id: string;
  settlement_id: string;
  wallet_id: string;
  chain_id: number;
  token: 'USDC';
  amount: number;
  tx_hash?: string;
  status: PayoutStatus;
  created_at: string;
  confirmed_at?: string;
}

export interface HaulReceipt {
  id: string;
  settlement_id: string;
  load_id: string;
  plate?: string;
  miles: number;
  rate_per_mile: number;
  reserve_amount: number;
  holder_slice: number;
  written_at: string;
}
