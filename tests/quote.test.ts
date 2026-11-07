/**
 * Quote totals carry no gross adder. Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeQuote, type RateCard } from '../database/quote';

const CARD: RateCard = {
  equipment_key: 'dry_van',
  label: 'Dry Van',
  cdl_required: true,
  rate_min_per_mile: 2,
  rate_max_per_mile: 3,
  base_rate_per_mile: 2,
  short_haul_under_miles: null,
  short_haul_rate_min_per_mile: null,
  short_haul_rate_max_per_mile: null,
  short_haul_base_rate_per_mile: null,
  minimum_charge: 500,
  short_haul_minimum_charge: null,
  deadhead_buffer_pct: 0,
  express_surcharge_pct: 0.15
};

const quote = (miles: number, express = false) =>
  computeQuote(CARD, { miles, deadhead_miles: 0, demand_multiplier: 1, express, accessorials: [] });

test('the quoted total is the linehaul with nothing added on top', () => {
  assert.equal(quote(1000).quoted_total, 2000);
  assert.equal(quote(1000).quoted_rate_per_mile, 2);
});

test('express still applies', () => {
  assert.equal(quote(1000, true).quoted_total, 2300);
});

test('the distance minimum still floors the total', () => {
  assert.equal(quote(100).quoted_total, 500);
  assert.equal(quote(100).minimum_applied, true);
});
