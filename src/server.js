import { createServer as httpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createAuth, equalSecret } from './auth.js';
import { createMobieClient } from './mobie.js';
import { createMapboxClient } from './mapbox.js';
import { createAustrianAddressMatcher } from './austrian-addresses.js';
import { HttpError } from './http.js';
import { loadConfig } from './config.js';

const page = readFileSync(new URL('./index.html', import.meta.url));
const script = readFileSync(new URL('./page.js', import.meta.url));

async function readJson(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use Content-Type: application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, 'JSON body is too large (maximum 16 KiB).');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request body must be a JSON object.');
  return value;
}

export function createServer(config, services = {}) {
  const auth = services.auth ?? createAuth(config);
  const mobie = services.mobie ?? createMobieClient({ baseUrl: config.baseUrl, getAccessToken: auth.getAccessToken });
  const addressMatcher = services.addressMatcher ?? createAustrianAddressMatcher();
  const mapbox = services.mapbox ?? createMapboxClient({ token: config.mapboxToken, addressMatcher });
  const secureCookie = new URL(config.redirectUri).protocol === 'https:' ? '; Secure' : '';
  const cookie = (state, maxAge) => `mobie_oauth_state=${state}; Path=/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie}`;

  const server = httpServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(page);
      }
      if (req.method === 'GET' && url.pathname === '/page.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(script);
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/callback') {
        const cookieState = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('mobie_oauth_state='))?.slice('mobie_oauth_state='.length);
        await auth.finishLogin({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), cookieState });
        res.writeHead(303, { Location: '/?login=success', 'Set-Cookie': cookie('', 0) });
        return res.end();
      }
      if (!equalSecret(req.headers.authorization, `Bearer ${config.apiKey}`)) throw new HttpError(401, 'Use the STARTER_API_KEY as a Bearer token for this server.');
      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const { url: authorizeUrl, state } = auth.beginLogin();
        res.setHeader('Set-Cookie', cookie(state, 600));
        return json(200, { url: authorizeUrl });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        auth.logout();
        return json(200, { authenticated: false });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(200, auth.status());
      if (req.method === 'GET' && url.pathname === '/api/me') return json(200, await mobie.me());
      if (req.method === 'POST' && url.pathname === '/api/locations/search') {
        return json(200, await mapbox.searchLocations((await readJson(req)).query));
      }
      if (req.method === 'POST' && url.pathname === '/api/rides/search') {
        return json(200, await mobie.searchRides(await readJson(req)));
      }
      const ride = /^\/api\/rides\/([a-zA-Z0-9_-]{1,128})(?:\/(join-detailed|rider-detail))?$/.exec(url.pathname);
      if (ride && req.method === 'POST' && ride[2] === 'join-detailed') {
        const { confirmed, ...payload } = await readJson(req);
        return json(200, await mobie.joinRide(ride[1], payload, { confirmed }));
      }
      if (ride && req.method === 'GET' && ride[2] === 'rider-detail') return json(200, await mobie.riderRideDetails(ride[1]));
      if (ride && req.method === 'GET' && !ride[2]) return json(200, await mobie.driverRideDetails(ride[1]));
      throw new HttpError(404, 'Endpoint not found. See docs/api.md.');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Unexpected server error.' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = loadConfig();
    const server = createServer(config);
    server.on('error', error => { console.error(`Cannot start server (${error.code ?? 'unknown error'}).`); process.exitCode = 1; });
    server.listen(config.port, config.host, () => console.log(`mobie starter: http://localhost:${config.port}\nOpen the page and sign in with your staging passenger account. Tokens stay in memory; restart requires login.`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

