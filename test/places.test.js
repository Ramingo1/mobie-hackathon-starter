import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceMatcher } from '../src/places.js';
import { createMapboxClient } from '../src/mapbox.js';

const feature = (properties = {}, coordinates = [14.2869766, 48.3060622]) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates }, properties: {
    name: 'Altes Rathaus', street: 'Hauptplatz', housenumber: '1', city: 'Linz', postcode: '4020',
    countrycode: 'AT', osm_key: 'amenity', osm_value: 'townhall', ...properties,
  },
});
const client = fetch => createPlaceMatcher({ fetch, minIntervalMs: 0 });

test('landmark lookup preserves real address and coordinates and requires confirmation', async () => {
  let calls = 0;
  const places = client(async url => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://photon.komoot.io');
    assert.equal(parsed.searchParams.get('countrycode'), 'AT');
    assert.equal(parsed.searchParams.get('q'), 'Altes Rathaus, Linz');
    return Response.json({ features: [feature()] });
  });
  const result = await places.searchLocations('Altes Rathaus, 4020 Linz');
  assert.deepEqual(result.candidates[0], { publicName: 'Altes Rathaus', addressLine: 'Altes Rathaus, Hauptplatz 1, 4020 Linz',
    longitude: 14.2869766, latitude: 48.3060622, street: 'Hauptplatz', houseNumber: '1', postcode: '4020', city: 'Linz',
    matchType: 'point-of-interest', requiresConfirmation: true, addressComplete: true, entranceVerified: false });
  assert.match(result.attribution, /OpenStreetMap/);
  result.candidates.length = 0;
  assert.equal((await places.searchLocations('Altes Rathaus, 4020 Linz')).candidates.length, 1);
  assert.equal(calls, 1);
});

test('reject other countries, towns, postcodes, unrelated names and invalid coordinates', async () => {
  const places = client(async () => Response.json({ features: [
    feature({ countrycode: 'DE', city: 'Linz am Rhein' }), feature({ city: 'Enns' }),
    feature({ postcode: '4040' }), feature({ name: 'Altes Goldschmied-Haus' }), feature({}, [null, 48.3]),
    feature({}, [181, 48.3]), feature({ osm_key: 'highway' }),
  ] }));
  assert.deepEqual((await places.searchLocations('Altes Rathaus, 4020 Linz')).candidates, []);
});

test('deduplicate nearby building entries, preserve distant branches and never invent missing address', async () => {
  const places = client(async () => Response.json({ features: [
    feature({ housenumber: undefined }, [14.2868523, 48.3060574]), feature(),
    feature({ street: undefined, housenumber: undefined }, [14.3, 48.31]),
  ] }));
  const result = await places.searchLocations('Altes Rathaus in Linz');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].houseNumber, '1');
  assert.equal(result.candidates[1].addressComplete, false);
  assert.equal(result.candidates[1].houseNumber, null);
});

test('validation prevents requests without locality and provider failures are not cached', async () => {
  let calls = 0;
  const places = client(async () => { calls++; return calls === 1 ? new Response('failure', { status: 503 }) : Response.json({ features: [feature()] }); });
  assert.deepEqual((await places.searchLocations('Altes Rathaus')).candidates, []);
  await assert.rejects(places.searchLocations('Rathaus; Linz'), error => error.status === 400);
  assert.equal(calls, 0);
  await assert.rejects(places.searchLocations('Altes Rathaus, Linz'), error => error.status === 503);
  assert.equal((await places.searchLocations('Altes Rathaus, Linz')).candidates.length, 1);
});

test('landmarks skip street lookup, while existing streets and house numbers retain their path', async () => {
  let streetCalls = 0, placeCalls = 0;
  const locations = createMapboxClient({ addressMatcher: { searchLocations: async () => { streetCalls++; return { candidates: [{ publicName: 'Landstraße 15' }] }; } },
    placeMatcher: { searchLocations: async () => { placeCalls++; return { candidates: [{ publicName: 'Altes Rathaus' }] }; } } });
  assert.equal((await locations.searchLocations('Altes Rathaus, Linz')).candidates[0].publicName, 'Altes Rathaus');
  assert.equal(streetCalls, 0);
  await locations.searchLocations('Landstraße 15, Linz');
  await locations.searchLocations('Landstraße, Linz');
  assert.equal(streetCalls, 2);
  assert.equal(placeCalls, 1);
});
