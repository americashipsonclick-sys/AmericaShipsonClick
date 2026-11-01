import type { PlatformConfig } from '../types/api';

/**
 * Same fallbacks as GET /api/config and PATCH /bookings/:id/complete.
 * The ledger is the source of truth; this helper exists so the board,
 * the post-load calculator, and the homepage receipt cannot drift from it.
 */
export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  fee_pct: 0.07,
  factor_pct: 0.03,
  broker_comparison_pct: 0.20,
  fuel_rate_per_mile: 0.45
};

export function withConfigDefaults(config?: Partial<PlatformConfig> | null): PlatformConfig {
  return {
    fee_pct: config?.fee_pct ?? DEFAULT_PLATFORM_CONFIG.fee_pct,
    factor_pct: config?.factor_pct ?? DEFAULT_PLATFORM_CONFIG.factor_pct,
    broker_comparison_pct: config?.broker_comparison_pct ?? DEFAULT_PLATFORM_CONFIG.broker_comparison_pct,
    fuel_rate_per_mile: config?.fuel_rate_per_mile ?? DEFAULT_PLATFORM_CONFIG.fuel_rate_per_mile
  };
}

export interface SettlementPreview {
  miles: number;
  ratePerMile: number;
  feePct: number;
  factorPct: number;
  fuelRate: number;
  brokerPct: number;
  factored: boolean;
  gross: number;
  fee: number;
  fuel: number;
  factor: number;
  net: number;
  brokerKeep: number;
  brokerCarrier: number;
}

export function settlementPreview(
  miles: number,
  ratePerMile: number,
  config?: Partial<PlatformConfig> | null,
  opts?: { factored?: boolean }
): SettlementPreview {
  const cfg = withConfigDefaults(config);
  const m = Number(miles) || 0;
  const rate = Number(ratePerMile) || 0;
  const factored = Boolean(opts?.factored);
  const gross = m * rate;
  const fee = gross * cfg.fee_pct;
  const fuel = m * cfg.fuel_rate_per_mile;
  const factor = factored ? gross * cfg.factor_pct : 0;
  const net = gross - fee - fuel - factor;
  const brokerKeep = gross * cfg.broker_comparison_pct;
  return {
    miles: m,
    ratePerMile: rate,
    feePct: cfg.fee_pct,
    factorPct: cfg.factor_pct,
    fuelRate: cfg.fuel_rate_per_mile,
    brokerPct: cfg.broker_comparison_pct,
    factored,
    gross,
    fee,
    fuel,
    factor,
    net,
    brokerKeep,
    brokerCarrier: gross - brokerKeep
  };
}

export function usd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function pctLabel(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}
