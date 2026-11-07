import { HttpError, requestJson } from './http.js';
import { parseAddress } from './austrian-addresses.js';

export function createMapboxClient({ token, fetch = globalThis.fetch, addressMatcher, placeMatcher }) {
  return {
    async searchLocations(query) {
      if (typeof query !== 'string' || !query.trim() || query.length > 256 || query.includes(';') || query.trim().split(/\s+/).length > 20) {
        throw new HttpError(400, 'query must contain 1–256 characters, at most 20 words and no semicolon.');
      }
      // Prefer canonical Austrian register data and coordinates. This path does not require a Mapbox token.
      if (addressMatcher?.searchLocations) {
        const parsed = parseAddress(query.trim());
        // Landmark names are not streets. Avoid the street-directory round trip for
        // them; ordinary street/house-number searches retain their existing path.
        const looksLikeStreet = parsed && (parsed.houseNumber || /(?:straße|strasse|str\.|gasse|platz|weg|allee|ring|kai|zeile|promenade)$/iu.test(parsed.street));
        if (placeMatcher && parsed && !looksLikeStreet) {
          const places = await placeMatcher.searchLocations(query.trim());
          if (places.candidates.length) return places;
        }
        const addresses = await addressMatcher.searchLocations(query.trim());
        if (addresses.candidates.length || !placeMatcher || !parsed || parsed.houseNumber || !looksLikeStreet) return addresses;
        return placeMatcher.searchLocations(query.trim());
      }
      if (!token) throw new HttpError(503, 'Set your own MAPBOX_ACCESS_TOKEN in .env to use geocoding.');
      // The BEV-derived street directory helps correct transcription errors before geocoding.
      let corrected = [];
      try { corrected = await addressMatcher?.suggestQueries(query.trim()) ?? []; } catch { /* fall back to the raw query */ }
      const queries = corrected.length ? corrected.map(match => match.query) : [query.trim()];
      const uniqueQueries = [...new Set(queries)];
      const results = await Promise.all(uniqueQueries.map(async searchQuery => {
        // mobie stores locations even during search. Use permanent geocoding accordingly.
        const url = new URL('https://api.mapbox.com/search/geocode/v6/forward');
        url.search = new URLSearchParams({ q: searchQuery, access_token: token, country: 'AT', language: 'de', limit: '5', autocomplete: 'false', permanent: 'true' }).toString();
        return requestJson(url.toString(), {}, { fetch, service: 'Mapbox' });
      }));
      if (results.some(result => !Array.isArray(result?.features))) throw new HttpError(502, 'Mapbox returned an unexpected response.');
      const candidates = results.flatMap(result => result.features.map(feature => {
        const p = feature.properties ?? {};
        const coordinates = p.coordinates ?? {};
        return {
          publicName: p.name_preferred ?? p.name ?? '',
          addressLine: p.full_address ?? [p.name, p.place_formatted].filter(Boolean).join(', '),
          longitude: coordinates.longitude ?? feature.geometry?.coordinates?.[0],
          latitude: coordinates.latitude ?? feature.geometry?.coordinates?.[1],
        };
      })).filter(p => Number.isFinite(p.longitude) && Number.isFinite(p.latitude));
      const seen = new Set();
      const uniqueCandidates = candidates.filter(candidate => {
        const key = `${candidate.addressLine}:${candidate.longitude}:${candidate.latitude}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const attribution = [results.find(result => result.attribution)?.attribution, corrected.length ? addressMatcher.attribution : ''].filter(Boolean).join(' · ');
      return { candidates: uniqueCandidates, attribution };
    },
  };
}
