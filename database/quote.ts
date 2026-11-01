/**
 * Equipment quote math. Rates come from `equipment_rate_cards`; this module
 * only applies them. The 7% gross markup is the shipper quote adder — it is
 * not the Open Books platform fee (`platform_config.fee_pct`).
 */

export const EQUIPMENT_KEYS = [
  'cargo_van',
  'bumper_pull',
  'gooseneck_hotshot',
  'gooseneck_cdl_40',
  'gooseneck_specialized',
  'car_carrier',
  'flatbed',
  'oversize_legal',
  'oversize_permitted',
  'dry_van',
  'reefer',
  'step_deck',
  'power_only'
] as const;

export type EquipmentKey = (typeof EQUIPMENT_KEYS)[number];

export interface RateCard {
  equipment_key: EquipmentKey | string;
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
  fuel_mpg: number;
  express_surcharge_pct: number;
}

export interface QuoteAccessorial {
  code: string;
  label: string;
  amount: number;
}

export interface QuoteParams {
  miles: number;
  deadhead_miles: number;
  demand_multiplier: number;
  express: boolean;
  accessorials: QuoteAccessorial[];
  diesel_ppg: number;
  diesel_base_ppg: number;
  quote_gross_pct: number;
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
  diesel_ppg: number;
  diesel_base_ppg: number;
  fuel_mpg: number;
  fuel_surcharge_per_mile: number;
  fuel_surcharge: number;
  accessorials: QuoteAccessorial[];
  accessorials_amount: number;
  demand_multiplier: number;
  express: boolean;
  express_surcharge_pct: number;
  after_demand: number;
  after_express: number;
  quote_gross_pct: number;
  gross_markup: number;
  quoted_total: number;
  quoted_rate_per_mile: number;
}

function money(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function rpm(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
}

function num(n: number | string | null | undefined, fallback = 0): number {
  const v = typeof n === 'string' ? parseFloat(n) : Number(n);
  return Number.isFinite(v) ? v : fallback;
}

export function computeQuote(card: RateCard, params: QuoteParams): QuoteBreakdown {
  const miles = Math.max(0, num(params.miles));
  const deadheadMiles = Math.max(0, num(params.deadhead_miles));
  const demand = Math.max(0.01, num(params.demand_multiplier, 1));
  const grossPct = Math.max(0, num(params.quote_gross_pct));
  const diesel = Math.max(0, num(params.diesel_ppg));
  const dieselBase = Math.max(0, num(params.diesel_base_ppg));
  const mpg = Math.max(0.1, num(card.fuel_mpg, 6.5));

  const shortUnder = card.short_haul_under_miles == null ? null : num(card.short_haul_under_miles);
  const shortHaul = shortUnder != null && miles > 0 && miles < shortUnder;

  const appliedRate = rpm(
    shortHaul && card.short_haul_base_rate_per_mile != null
      ? num(card.short_haul_base_rate_per_mile)
      : num(card.base_rate_per_mile)
  );

  let floor = Math.max(0, num(card.minimum_charge));
  if (shortHaul && card.short_haul_minimum_charge != null) {
    floor = Math.max(floor, num(card.short_haul_minimum_charge));
  }

  const linehaulRaw = money(miles * appliedRate);
  const minimumApplied = linehaulRaw < floor;
  const linehaul = money(Math.max(linehaulRaw, floor));

  const deadheadFromMiles = money(deadheadMiles * appliedRate);
  const deadheadFromBuffer = money(linehaul * num(card.deadhead_buffer_pct));
  const deadheadAmount = money(Math.max(deadheadFromMiles, deadheadFromBuffer));

  const fuelPerMile = rpm(Math.max(0, diesel - dieselBase) / mpg);
  const fuelSurcharge = money(miles * fuelPerMile);

  const accessorials = params.accessorials.map(a => ({
    code: a.code,
    label: a.label,
    amount: money(Math.max(0, num(a.amount)))
  }));
  const accessorialsAmount = money(accessorials.reduce((s, a) => s + a.amount, 0));

  const preMult = money(Math.max(0, linehaul + deadheadAmount + fuelSurcharge + accessorialsAmount));
  const afterDemand = money(preMult * demand);
  const expressPct = params.express ? Math.max(0, num(card.express_surcharge_pct)) : 0;
  const afterExpress = money(afterDemand * (1 + expressPct));
  const grossMarkup = money(afterExpress * grossPct);
  const quotedTotal = money(Math.max(afterExpress + grossMarkup, floor));
  const quotedRpm = miles > 0 ? rpm(quotedTotal / miles) : 0;

  return {
    equipment_key: String(card.equipment_key),
    label: card.label,
    miles,
    applied_rate_per_mile: appliedRate,
    short_haul: shortHaul,
    linehaul_raw: linehaulRaw,
    minimum_floor: money(floor),
    minimum_applied: minimumApplied || quotedTotal === floor,
    linehaul,
    deadhead_miles: deadheadMiles,
    deadhead_from_miles: deadheadFromMiles,
    deadhead_from_buffer: deadheadFromBuffer,
    deadhead_amount: deadheadAmount,
    diesel_ppg: diesel,
    diesel_base_ppg: dieselBase,
    fuel_mpg: mpg,
    fuel_surcharge_per_mile: fuelPerMile,
    fuel_surcharge: fuelSurcharge,
    accessorials,
    accessorials_amount: accessorialsAmount,
    demand_multiplier: demand,
    express: Boolean(params.express),
    express_surcharge_pct: expressPct,
    after_demand: afterDemand,
    after_express: afterExpress,
    quote_gross_pct: grossPct,
    gross_markup: grossMarkup,
    quoted_total: quotedTotal,
    quoted_rate_per_mile: quotedRpm
  };
}
