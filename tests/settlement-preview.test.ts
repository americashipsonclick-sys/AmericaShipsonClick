/**
 * The "You keep" figure has to match what settlement pays. Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFactored, settlementPreview } from '../frontend/src/lib/settlementPreview';

test("the driver's preference outranks the load's offer", () => {
  assert.equal(isFactored(false, true), true);
  assert.equal(isFactored(true, false), false);
});

test("the load's offer applies only when there is no preference", () => {
  assert.equal(isFactored(true, null), true);
  assert.equal(isFactored(true, undefined), true);
  assert.equal(isFactored(false, null), false);
  assert.equal(isFactored(null, null), false);
});

test('a preview for an opted-in driver takes off the factor', () => {
  const net = (optIn: boolean) =>
    settlementPreview(780, 2.15, null, { factored: isFactored(false, optIn) }).net;
  assert.ok(Math.abs(net(false) - 1677) < 0.001);
  assert.ok(Math.abs(net(true) - 1626.69) < 0.001);
});
