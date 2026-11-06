import { requestJson } from './http.js';

const STATES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const POSTCODE_STATES = {
  '1': ['9'],
  '2': ['1', '3'],
  '3': ['3'],
  '4': ['4'],
  '5': ['5'],
  '6': ['7', '8'],
  '7': ['1'],
  '8': ['6'],
  '9': ['2'],
};
const ATTRIBUTION = '© Österreichisches Adressregister, Datenquelle geocode.at';

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/gi, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parseAddress(query) {
  const parts = query.split(',').map(part => part.trim()).filter(Boolean);
  let address = '';
  let context = '';
  if (parts.length > 1) {
    address = parts[0];
    context = parts.slice(1).join(' ');
  } else {
    const postcode = /\b(\d{4})\s+(.+)$/u.exec(query.trim());
    const inCity = /^(.*?)\s+\bin\s+(.+)$/iu.exec(query.trim());
    if (postcode) {
      address = query.trim().slice(0, postcode.index).trim();
      context = `${postcode[1]} ${postcode[2]}`;
    } else if (inCity) {
      address = inCity[1].trim();
      context = inCity[2].trim();
    } else {
      return null;
    }
  }

  context = context.replace(/\b(?:Österreich|Austria)\b/giu, '').replace(/[.,;:]+/gu, ' ').replace(/\s+/g, ' ').trim();
  address = address.replace(/^[\s,.;:]+|[\s,.;:]+$/gu, '').replace(/\s+/g, ' ').trim();
  const postcode = /\b(\d{4})\b/u.exec(context)?.[1] ?? '';
  const city = context.replace(/\b\d{4}\b/gu, '').replace(/\s+/g, ' ').trim();
  const numberMatch = /\s+(\d+[a-zA-Z]?(?:\/\d+[a-zA-Z]?)?)\s*$/u.exec(address);
  const houseNumber = numberMatch?.[1] ?? '';
  const street = numberMatch ? address.slice(0, numberMatch.index).trim() : address;
  if (!city || normalize(city).length < 2 || normalize(street).length < 3) return null;
  return { city, postcode, street, houseNumber };
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[right.length];
}

export function createAustrianAddressMatcher({ fetch = globalThis.fetch } = {}) {
  const cityStateCache = new Map();
  const streetCatalogCache = new Map();

  async function getJson(url) {
    return requestJson(url, {}, { fetch, service: 'Österreichisches Adressverzeichnis' });
  }

  async function statesForCity(city, postcode) {
    const possibleStates = postcode ? (POSTCODE_STATES[postcode[0]] ?? STATES) : STATES;
    const key = `${normalize(city)}:${possibleStates.join(',')}`;
    if (!cityStateCache.has(key)) {
      cityStateCache.set(key, Promise.all(possibleStates.map(async state => {
        try {
          const url = new URL('https://www.geocode.at/autocomplete');
          url.search = new URLSearchParams({ state, city }).toString();
          const result = await getJson(url.toString());
          const names = Array.isArray(result) ? result : [result];
          return names.some(name => normalize(name) === normalize(city)) ? state : null;
        } catch {
          return null;
        }
      })).then(results => results.filter(Boolean)));
    }
    return cityStateCache.get(key);
  }

  async function streetsForState(state) {
    if (!streetCatalogCache.has(state)) {
      const url = new URL('https://www.geocode.at/list');
      url.search = new URLSearchParams({ state }).toString();
      streetCatalogCache.set(state, getJson(url.toString()).then(rows => {
        if (!Array.isArray(rows)) throw new Error('Unexpected Austrian street directory response.');
        return rows.filter(row => typeof row?.Place === 'string' && typeof row?.Street === 'string');
      }).catch(error => {
        streetCatalogCache.delete(state);
        throw error;
      }));
    }
    return streetCatalogCache.get(state);
  }

  async function autocomplete(params) {
    const url = new URL('https://www.geocode.at/autocomplete');
    url.search = new URLSearchParams(params).toString();
    const result = await getJson(url.toString());
    return (Array.isArray(result) ? result : [result]).filter(value => value != null && value !== '');
  }

  async function suggestQueries(query) {
      const parsed = parseAddress(query);
      if (!parsed) return [];
      const states = await statesForCity(parsed.city, parsed.postcode);
      if (!states.length) return [];
      const catalogs = await Promise.all(states.map(streetsForState));
      const cityKey = normalize(parsed.city);
      const streetKey = normalize(parsed.street);
      const matches = [];
      for (const [catalogIndex, rows] of catalogs.entries()) {
        for (const row of rows) {
          if (normalize(row.Place) !== cityKey) continue;
          const candidateKey = normalize(row.Street);
          const distance = editDistance(streetKey, candidateKey);
          const maxLength = Math.max(streetKey.length, candidateKey.length);
          const similarity = maxLength ? 1 - distance / maxLength : 0;
          const allowedDistance = Math.max(1, Math.floor(streetKey.length * 0.2));
          if (distance > allowedDistance || similarity < 0.78) continue;
          const location = [parsed.postcode, row.Place].filter(Boolean).join(' ');
          const address = [row.Street, parsed.houseNumber].filter(Boolean).join(' ');
          matches.push({
            query: `${address}, ${location}`,
            state: states[catalogIndex],
            city: row.Place,
            postcode: parsed.postcode,
            street: row.Street,
            houseNumber: parsed.houseNumber,
            distance,
            similarity,
          });
        }
      }
      matches.sort((a, b) => a.distance - b.distance || a.street.localeCompare(b.street, 'de'));
      const bestDistance = matches[0]?.distance;
      return matches
        .filter(match => match.distance <= bestDistance + 1)
        .slice(0, 3);
  }

  return {
    attribution: ATTRIBUTION,
    suggestQueries,
    async searchLocations(query) {
      const matches = await suggestQueries(query);
      const candidates = [];
      const geocode = async (match, houseNumber) => {
        const url = new URL('https://www.geocode.at/geocode');
        url.search = new URLSearchParams({
          state: match.state,
          city: match.city,
          street: match.street,
          ...(houseNumber ? { streetNo: houseNumber } : {}),
        }).toString();
        const result = await getJson(url.toString());
        const rows = Array.isArray(result) ? result : [result];
        return rows.flatMap(row => {
          const longitude = Number(row?.lng);
          const latitude = Number(row?.lat);
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
          const address = [match.street, houseNumber].filter(Boolean).join(' ');
          return [{
            publicName: address,
            addressLine: `${address}, ${[match.postcode, match.city].filter(Boolean).join(' ')}`,
            longitude,
            latitude,
          }];
        });
      };

      const nearbyHouseNumbers = async match => {
        const digits = /^(\d+)/u.exec(match.houseNumber ?? '')?.[1];
        if (!digits) return [];
        // geocode.at's number autocomplete is prefix based. Shorten the prefix until it returns
        // nearby registered numbers, then only offer numerically adjacent alternatives.
        for (let length = Math.min(2, digits.length); length >= 1; length--) {
          let numbers;
          try {
            numbers = await autocomplete({ state: match.state, city: match.city, street: match.street, streetNo: digits.slice(0, length) });
          } catch {
            return [];
          }
          const options = numbers.map(String)
            .filter(value => value !== match.houseNumber && /^\d+[a-z]?(?:\/\d+[a-z]?)?$/iu.test(value))
            .map(value => ({ value, distance: Math.abs(Number(/^\d+/u.exec(value)?.[0]) - Number(digits)) }))
            .filter(item => item.distance <= 2)
            .sort((a, b) => a.distance - b.distance || a.value.localeCompare(b.value, 'de'));
          if (options.length) return options.slice(0, 3).map(item => item.value);
        }
        return [];
      };

      for (const match of matches) {
        if (!match.state) continue;
        try {
          const exact = await geocode(match, match.houseNumber);
          candidates.push(...exact);
          if (!exact.length && match.houseNumber) {
            const alternatives = await nearbyHouseNumbers(match);
            for (const houseNumber of alternatives) {
              try { candidates.push(...await geocode(match, houseNumber)); } catch { /* Skip invalid alternatives. */ }
            }
          }
        } catch {
          // An invalid house number can still have nearby registered alternatives.
          if (match.houseNumber) {
            const alternatives = await nearbyHouseNumbers(match);
            for (const houseNumber of alternatives) {
              try { candidates.push(...await geocode(match, houseNumber)); } catch { /* Skip invalid alternatives. */ }
            }
          }
        }
      }
      return { candidates, attribution: ATTRIBUTION };
    },
  };
}

