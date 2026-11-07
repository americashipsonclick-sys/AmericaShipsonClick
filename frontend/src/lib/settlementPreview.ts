import type { PlatformConfig } from '../types/api';

/**
 * Same fallbacks as GET /api/config and PATCH /bookings/:id/complete.
 * The ledger is the source of truth; this helper exists so the board,
 * the post-load calculator, and the homepage receipt cannot drift from it.
 */
export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  factor_pct: 0.03,
  broker_comparison_pct: 0.20
};

export function withConfigDefaults(config?: Partial<PlatformConfig> | null): PlatformConfig {
  return {
    factor_pct: config?.factor_pct ?? DEFAULT_PLATFORM_CONFIG.factor_pct,
    broker_comparison_pct: config?.broker_comparison_pct ?? DEFAULT_PLATFORM_CONFIG.broker_comparison_pct
  };
}

/**
 * Same rule as PATCH /bookings/:id/complete: the driver's stored preference
 * decides, and the load's offer only applies when there is no preference.
 */
export function isFactored(offered: boolean | null | undefined, driverOptIn?: boolean | null): boolean {
  return Boolean(driverOptIn ?? offered);
}

export interface SettlementPreview {
  miles: number;
  ratePerMile: number;
  factorPct: number;
  brokerPct: number;
  factored: boolean;
  gross: number;
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
  const factor = factored ? gross * cfg.factor_pct : 0;
  const net = gross - factor;
  const brokerKeep = gross * cfg.broker_comparison_pct;
  return {
    miles: m,
    ratePerMile: rate,
    factorPct: cfg.factor_pct,
    brokerPct: cfg.broker_comparison_pct,
    factored,
    gross,
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
