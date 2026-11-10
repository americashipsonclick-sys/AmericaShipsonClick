/**
 * Post Load suggests US cities and ZIPs from the built-in list as the
 * shipper types. Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchUsPlaces } from '../backend/usPlaces';

const labels = (q: string) => searchUsPlaces(q).map((place) => place.label);

test('a partial city name puts the biggest match first', () => {
  assert.equal(labels('Atla')[0], 'Atlanta, GA');
  assert.equal(labels('Chi')[0], 'Chicago, IL');
});

test('a city with a state code or state name stays in that state', () => {
  assert.equal(labels('Dallas tx')[0], 'Dallas, TX');
  assert.equal(labels('atlanta georgia')[0], 'Atlanta, GA');
  assert.ok(searchUsPlaces('springfield, il').every((place) => place.state === 'IL'));
});

test('a state name alone lists its cities', () => {
  const places = searchUsPlaces('Georgia');
  assert.ok(places.length > 0);
  assert.ok(places.every((place) => place.state === 'GA'));
});

test('an exact small town still comes before bigger partial matches', () => {
  assert.equal(searchUsPlaces('Paris tx')[0].label, 'Paris, TX');
  assert.ok(labels('Paris').every((label, i) => i > 0 || label.startsWith('Paris, ')));
});

test('a later word in the name matches', () => {
  assert.ok(labels('york').includes('New York, NY'));
});

test('a full or partial ZIP finds that ZIP', () => {
  const [exact] = searchUsPlaces('30301');
  assert.equal(exact.label, 'Atlanta, GA 30301');
  assert.equal(exact.kind, 'postcode');
  assert.equal(exact.zip, '30301');
  assert.ok(searchUsPlaces('303').every((place) => place.zip?.startsWith('303')));
});

test('Alaska and Hawaii are covered', () => {
  assert.equal(labels('Anchorage')[0], 'Anchorage, AK');
  assert.equal(labels('Honolulu')[0], 'Honolulu, HI');
});

test('every hit carries coordinates for the map', () => {
  for (const place of searchUsPlaces('San')) {
    assert.ok(Number.isFinite(place.lat) && Number.isFinite(place.lng));
    assert.match(place.state, /^[A-Z]{2}$/);
  }
});
