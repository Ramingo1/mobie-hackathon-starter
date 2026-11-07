import test from 'node:test';
import assert from 'node:assert/strict';
import { createAustrianAddressMatcher } from '../src/austrian-addresses.js';

const streets = ['Landstraße', 'Peter-Behrens-Platz', 'Kudlichstraße', 'Hauptplatz'];
function fixture({ outage = () => false, invalid = false } = {}) {
  const calls = [];
  const fetch = async input => {
    const url = new URL(input), p = url.searchParams;
    calls.push(url);
    if (outage()) return new Response('unavailable', { status: 503 });
    if (url.pathname === '/autocomplete') {
      return Response.json(p.has('streetNo') ? ['27', '29', '41'] : p.get('state') === '4' ? ['Linz'] : []);
    }
    if (url.pathname === '/list') {
      assert.equal(p.get('city'), 'Linz', 'fetch only the requested city catalog');
      return Response.json([...streets.map(Street => ({ Place: 'Linz', Street })),
        { Place: 'Linz-Land', Street: 'Landstraße' }, { Place: 'Wien', Street: 'Landstraße' }]);
    }
    if (url.pathname === '/dictionary') {
      const street = p.get('street');
      assert.ok(streets.includes(street), 'only canonical register names reach geocoding');
      return Response.json({ Linz: { [street]: {
        15: [14.28911, 48.303314], 1: [14.288522, 48.304326], 2: [14.287977, 48.304007],
        3: invalid ? [null, null] : [14.288519, 48.304155],
        bad: [14.28, 48.3], 4: ['', ''], 5: [0, 0],
      } }, Wien: { [street]: { 99: [16.3, 48.2] } } });
    }
    if (url.pathname === '/geocode') {
      assert.ok(p.get('streetNo'), 'never geocode a missing house number');
      return Response.json(p.get('streetNo') === '28' ? {} : { lng: 14.28911, lat: 48.303314 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  return { matcher: createAustrianAddressMatcher({ fetch }), calls };
}

test('street-only search returns registered numbered meeting-point suggestions', async () => {
  const { matcher, calls } = fixture();
  const { candidates, attribution } = await matcher.searchLocations('Landstraße, Linz');
  assert.deepEqual(candidates.map(c => c.publicName), ['Landstraße 1', 'Landstraße 2', 'Landstraße 3']);
  assert.equal(candidates[0].longitude, 14.288522);
  assert.ok(candidates.every(c => c.requiresConfirmation && c.houseNumberSuggested && c.city === 'Linz'));
  assert.match(attribution, /Adressregister/);
  assert.equal(calls.filter(c => c.pathname === '/geocode').length, 0);
});

test('spoken misspellings, hyphens, umlauts and doubled letters resolve to real local streets', async () => {
  const { matcher } = fixture();
  for (const [query, expected] of [
    ['Peter Berens Platz, Linz', 'Peter-Behrens-Platz'],
    ['Peter Behrens Platz, Linz', 'Peter-Behrens-Platz'],
    ['Kuttlichstraße in Linz', 'Kudlichstraße'],
    ['Landstr. 15, 4020 Linz', 'Landstraße'],
  ]) {
    const { candidates } = await matcher.searchLocations(query);
    assert.ok(candidates.length, query);
    assert.ok(candidates.every(c => c.street === expected), query);
  }
});

test('unknown street and absent locality never produce invented addresses', async () => {
  const { matcher } = fixture();
  assert.deepEqual((await matcher.searchLocations('Unbekanntweg, Linz')).candidates, []);
  assert.deepEqual((await matcher.searchLocations('Landstraße')).candidates, []);
});

test('explicit house number is preserved; nearby alternatives are marked as suggestions', async () => {
  const { matcher } = fixture();
  const exact = (await matcher.searchLocations('Kudlichstraße 41, Linz')).candidates;
  assert.deepEqual(exact.map(c => c.houseNumber), ['41']);
  assert.equal(exact[0].houseNumberSuggested, false);
  const nearby = (await matcher.searchLocations('Kudlichstraße 28, Linz')).candidates;
  assert.deepEqual(nearby.map(c => c.houseNumber), ['27', '29']);
  assert.ok(nearby.every(c => c.houseNumberSuggested));
});

test('provider failure is reported and a later retry recovers instead of caching no matches', async () => {
  let failing = true;
  const { matcher } = fixture({ outage: () => failing });
  await assert.rejects(matcher.searchLocations('Landstraße, Linz'), error => error.status === 503);
  failing = false;
  assert.equal((await matcher.searchLocations('Landstraße, Linz')).candidates.length, 3);
});

test('malformed coordinates and non-numeric house keys are excluded', async () => {
  const { matcher, calls } = fixture({ invalid: true });
  const { candidates } = await matcher.searchLocations('Landstraße, 4020 Linz');
  assert.deepEqual(candidates.map(c => c.houseNumber), ['1', '2', '15']);
  assert.ok(candidates.every(c => c.postcode === '4020'));
  assert.equal(calls.find(c => c.pathname === '/dictionary').searchParams.get('zip'), '4020');
});

test('street catalog and city lookup are reused for the destination in the same city', async () => {
  const { matcher, calls } = fixture();
  await matcher.searchLocations('Landstraße, Linz');
  await matcher.searchLocations('Hauptplatz, Linz');
  assert.equal(calls.filter(c => c.pathname === '/list').length, 1);
  assert.equal(calls.filter(c => c.pathname === '/autocomplete').length, 9);
});

