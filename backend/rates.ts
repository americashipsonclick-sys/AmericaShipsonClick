import type { Queryable } from '../database';
import {
  computeQuote,
  type QuoteAccessorial,
  type QuoteBreakdown,
  type RateCard
} from '../database/quote';

function n(v: unknown, fallback = 0): number {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function nNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const x = n(v, NaN);
  return Number.isFinite(x) ? x : null;
}

export function cardFromRow(row: Record<string, unknown>): RateCard {
  return {
    equipment_key: String(row.equipment_key),
    label: String(row.label),
    cdl_required: Boolean(row.cdl_required),
    rate_min_per_mile: n(row.rate_min_per_mile),
    rate_max_per_mile: n(row.rate_max_per_mile),
    base_rate_per_mile: n(row.base_rate_per_mile),
    short_haul_under_miles: nNull(row.short_haul_under_miles),
    short_haul_rate_min_per_mile: nNull(row.short_haul_rate_min_per_mile),
    short_haul_rate_max_per_mile: nNull(row.short_haul_rate_max_per_mile),
    short_haul_base_rate_per_mile: nNull(row.short_haul_base_rate_per_mile),
    minimum_charge: n(row.minimum_charge),
    short_haul_minimum_charge: nNull(row.short_haul_minimum_charge),
    deadhead_buffer_pct: n(row.deadhead_buffer_pct),
    express_surcharge_pct: n(row.express_surcharge_pct)
  };
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
  quote_gross_pct: number;
  default_demand_multiplier: number;
}

export async function loadRateCatalog(db: Queryable): Promise<RateCatalog> {
  const [cards, fees, config] = await Promise.all([
    db.query(`SELECT * FROM equipment_rate_cards ORDER BY sort_order`),
    db.query(`SELECT code, label, amount, description FROM accessorial_fees ORDER BY code`),
    db.query<{ key: string; value: string }>(
      `SELECT key, value FROM platform_config WHERE key IN
        ('quote_gross_pct', 'default_demand_multiplier')`
    )
  ]);

  const cfg: Record<string, number> = {};
  for (const row of config.rows) cfg[row.key] = n(row.value);

  return {
    cards: cards.rows.map(cardFromRow),
    accessorials: fees.rows.map(r => ({
      code: String(r.code),
      label: String(r.label),
      amount: n(r.amount),
      description: r.description ? String(r.description) : undefined
    })),
    quote_gross_pct: cfg.quote_gross_pct ?? 0.07,
    default_demand_multiplier: cfg.default_demand_multiplier ?? 1
  };
}

export async function quoteFor(
  db: Queryable,
  input: {
    equipment_key: string;
    miles: number;
    deadhead_miles?: number;
    demand_multiplier?: number;
    express?: boolean;
    accessorial_codes?: string[];
  }
): Promise<{ catalog: RateCatalog; card: RateCard; quote: QuoteBreakdown }> {
  const catalog = await loadRateCatalog(db);
  const card = catalog.cards.find(c => c.equipment_key === input.equipment_key);
  if (!card) {
    throw Object.assign(new Error(`Unknown equipment type: ${input.equipment_key}`), { status: 400 });
  }

  const codes = new Set(input.accessorial_codes ?? []);
  const accessorials: QuoteAccessorial[] = catalog.accessorials.filter(a => codes.has(a.code));

  const quote = computeQuote(card, {
    miles: input.miles,
    deadhead_miles: input.deadhead_miles ?? 0,
    demand_multiplier: input.demand_multiplier ?? catalog.default_demand_multiplier,
    express: Boolean(input.express),
    accessorials,
    quote_gross_pct: catalog.quote_gross_pct
  });

  return { catalog, card, quote };
}
