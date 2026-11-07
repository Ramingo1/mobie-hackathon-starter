import { HttpError, requestJson } from './http.js';
import { parseAddress } from './austrian-addresses.js';

const ATTRIBUTION = '© OpenStreetMap contributors (ODbL), Ortssuche: Photon / komoot';
const key = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ß/g, 'ss').toLowerCase().replace(/[^a-z0-9]/g, '');

function nameMatches(query, name) {
  // Photon is fuzzy. Require every meaningful requested word as well, so a
  // different building in the same town cannot silently replace the request.
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(word => !['der', 'die', 'das', 'dem', 'den', 'zum', 'zur', 'am', 'beim'].includes(word))
    .map(key).filter(Boolean);
  const target = key(name);
  return words.length > 0 && words.every(word => target.includes(word));
}

export function createPlaceMatcher({ endpoint = 'https://photon.komoot.io/api/', fetch = globalThis.fetch,
  now = Date.now, minIntervalMs = 1000 } = {}) {
  const cache = new Map();
  let queue = Promise.resolve();
  let nextRequest = 0;
  return {
    async searchLocations(query) {
      if (typeof query !== 'string' || !query.trim() || query.length > 256 || query.includes(';') || query.trim().split(/\s+/).length > 20) {
        throw new HttpError(400, 'query must contain 1–256 characters, at most 20 words and no semicolon.');
      }
      const parsed = parseAddress(query);
      if (!parsed) return { candidates: [], attribution: ATTRIBUTION };
      const cacheKey = `${key(parsed.street)}:${key(parsed.city)}:${parsed.postcode}`;
      const saved = cache.get(cacheKey);
      if (saved && saved.expires > now()) return structuredClone(await saved.result);
      const result = queue.catch(() => {}).then(async () => {
        const wait = nextRequest - now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        nextRequest = now() + minIntervalMs;
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ q: `${parsed.street}, ${parsed.city}`, lang: 'de',
          countrycode: 'AT', bbox: '9,46,18,50', limit: '10' }).toString();
        const data = await requestJson(url.toString(), { headers: {
          'User-Agent': 'mobie-hackathon-starter/1.0 (place lookup)',
        } }, { fetch, service: 'Photon Ortssuche' });
        if (!Array.isArray(data?.features)) throw new HttpError(502, 'Photon returned an unexpected response.');
        const candidates = data.features.flatMap(feature => {
          const p = feature.properties ?? {};
          const point = feature.geometry?.coordinates;
          if (feature.geometry?.type !== 'Point' || !Array.isArray(point) ||
            !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
            point[0] < 9 || point[0] > 18 || point[1] < 46 || point[1] > 50 ||
            String(p.countrycode).toUpperCase() !== 'AT' || key(p.city) !== key(parsed.city) ||
            (parsed.postcode && String(p.postcode) !== parsed.postcode) ||
            !p.name || !nameMatches(parsed.street, p.name) ||
            ['place', 'highway', 'boundary'].includes(p.osm_key)) return [];
          const address = [p.street, p.housenumber].filter(Boolean).join(' ');
          return [{ publicName: p.name, addressLine: [p.name, address, [p.postcode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
            longitude: point[0], latitude: point[1], street: p.street || null,
            houseNumber: p.housenumber || null, postcode: p.postcode || null, city: p.city,
            matchType: 'point-of-interest', requiresConfirmation: true,
            addressComplete: Boolean(p.street && p.housenumber), entranceVerified: false }];
        });
        // OSM may list both a building and an information point at that building.
        // Prefer its complete address; don't collapse separate branches elsewhere.
        candidates.sort((a, b) => Number(b.addressComplete) - Number(a.addressComplete));
        const unique = candidates.filter((candidate, i, all) => !all.slice(0, i).some(other =>
          key(candidate.publicName) === key(other.publicName) && key(candidate.street) === key(other.street) &&
          Math.abs(candidate.latitude - other.latitude) < 0.0005 && Math.abs(candidate.longitude - other.longitude) < 0.0005));
        return { candidates: unique.slice(0, 3), attribution: ATTRIBUTION };
      });
      queue = result;
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, { result, expires: now() + 15 * 60_000 });
      try { return structuredClone(await result); }
      catch (error) { cache.delete(cacheKey); throw error; }
    },
  };
}
