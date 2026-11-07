# Hackathon starter API

The starter translates its local `/api/...` routes to mobie's dedicated
`/integrations/voice/...` API. There are no login, callback, logout, session-status,
`/api/me` or generic driver-detail routes.

## Local request headers

```http
Authorization: Bearer <STARTER_API_KEY>
X-Mobie-Caller-Phone: +436641234567
X-Mobie-Call-Id: <provider call ID>
Content-Type: application/json
```

Use the registered passenger's phone and the provider's stable call ID. Your
trusted adapter supplies both from provider metadata; model arguments cannot set
caller identity. For an explicitly configured phone-less browser test, omit the
phone and send `X-Mobie-Call-Type: webCall`. Invalid supplied phones never fall back.
Writes additionally require `Idempotency-Key: <stable confirmed action ID>` and
`confirmed: true` in the JSON body. Keep the same key, target and payload on retry.

## Routes

| Method | Starter path | Upstream path / behavior |
| --- | --- | --- |
| GET | `/health` | Public process health; no upstream request |
| GET | `/api/caller` | `/integrations/voice/caller`: `userId`, `firstName`, `savedPlaces` |
| POST | `/api/locations/search` | Austrian Address Register for streets; Photon/OSM for named buildings and landmarks, e.g. `{ "query": "Altes Rathaus, Linz" }`; only local key required |
| POST | `/api/rides/nearby` | `/integrations/voice/rides/nearby`: `{ "departure": { ...resolved location... } }` |
| POST | `/api/rides/search` | `/integrations/voice/rides/search`: resolved locations, time, seats |
| POST | `/api/rides/{rideId}/join-detailed` | `/integrations/voice/rides/{rideId}/join-detailed`: searched trip plus confirmation; pending driver approval |
| POST | `/api/ride-requests` | `/integrations/voice/ride-requests`: confirmed trip; creates an open request |
| GET | `/api/ride-requests?openOnly=true` | `/integrations/voice/ride-requests?openOnly=true`; omit the query for the normal list |
| GET | `/api/bookings?page=0` | `/integrations/voice/bookings?page=0`: `{ "bookings": [...], "nextPage": ... }` |
| GET | `/api/bookings/{bookingId}` | `/integrations/voice/bookings/{bookingId}`: latest booking status |
| GET | `/api/rides/{rideId}/rider-detail` | `/integrations/voice/rides/{rideId}/rider-detail`: requires driver approval |
| POST | `/api/ride-requests/{requestId}/withdraw` | `/integrations/voice/ride-requests/{requestId}/withdraw`: `{ "confirmed": true }` |
| POST | `/api/rides/{rideId}/bookings/{bookingId}/cancel` | `/integrations/voice/rides/{rideId}/bookings/{bookingId}/cancel`: `{ "confirmed": true }` |

### Named buildings and landmarks

Send one place name plus its town, separated by a comma or `in`, for example
`Altes Rathaus, 4020 Linz`. The existing location tool returns up to three
`point-of-interest` candidates with real coordinates and `requiresConfirmation`.
Only Austrian results in the requested town (and postcode when supplied) survive
filtering. Nearby duplicate building/information-point entries are consolidated.
Street searches retain the Austrian register and its house-number behavior.

Read the returned place name and address to the caller and get confirmation.
Missing street or house number remains null (`addressComplete: false`); do not
invent one. `entranceVerified: false` means the location is a mapped feature,
not a verified vehicle-accessible entrance or pickup bay. Clarify a suitable
meeting point when needed. No matches and provider failures are different states.

The default is the [Photon demo API](https://github.com/komoot/photon#demo-server),
permitted for modest project use without availability guarantees. Queries are
serialized at at most one per second per starter process and cached for 15 minutes
(up to 200 entries, including concurrent request deduplication). Only the place
name and town are sent, without caller identity or credentials. Preserve/display
the returned OpenStreetMap attribution with results. For higher traffic or multiple
instances use a private/hosted Photon endpoint through `PHOTON_URL` (HTTPS).
No public Nominatim API is used. Data is from OpenStreetMap contributors under
[ODbL](https://www.openstreetmap.org/copyright).

The starter's public root page and `/page.js` provide a manual connection test.
All `/api/...` routes require the local key. Only listed routes are proxied;
arbitrary backend URLs and administrative routes are inaccessible.

## Call logs and provider events

| Method | Starter route | Behavior |
| --- | --- | --- |
| POST | `/vapi/events` | Accept Vapi end-of-call/status reports; normalize and push to backend; 200 after acceptance |
| PUT | `/api/calls/{callId}` | Push a normalized call report to `/integrations/voice-log/calls/{callId}`; 204 after persistence |
| PUT | `/api/calls/{callId}/tools/{toolId}` | Push a normalized external tool event; 204 after persistence |

These routes need the local starter key and JSON, but no caller headers. Bodies
may be up to 8 MiB. Normal API operations carrying a valid call ID already push
their tool events automatically. Optional `X-Mobie-Tool-Call-Id` identifies the
provider tool event; otherwise an operation UUID is generated. It is separate
from the required idempotency key for domain writes.

See [call-logs.md](call-logs.md) for provider setup, schemas, automatic redaction,
retries and delivery limits. Transient report delivery exhaustion returns 503.

## Payload and response rules

Use the [voice integration payload](voice-integration.md#search-payload) for search,
join and open requests. Locations require a nonempty `publicName` and numeric
longitude/latitude; provider feature IDs and mobie location IDs cannot replace
coordinates in this API. Fonio decimal strings are normalized into JSON numbers.
`time` needs `Z` or an explicit offset; `seatsRequested` is 1–8, defaulting to 1.
The starter forwards `confirmed: true` to the voice backend for writes.

Successful upstream JSON is returned unchanged. Search returns an array, including
`[]`. Select `ride.id`, retain the passenger's searched locations and answer
pre-booking questions from the suggestion. Driver route endpoints may differ.
Submission is pending driver approval; query bookings for that decision. Follow
`nextPage` until null, even if an intermediate page has no visible bookings.

The starter never automatically retries writes or generates a fresh action key
for a retry. Persist your action key in your provider adapter before sending.
A replay returns the original successful submission result, not live status.

## Errors and limits

Local errors use `{ "error": "..." }`. The known upstream code
`AMBIGUOUS_CALLER` is preserved as `code`; arbitrary upstream bodies and error
messages are hidden to avoid leaking secrets. Upstream HTTP error statuses are
preserved. Network errors, timeouts and invalid upstream JSON return 502.

Local validation uses 400 (caller/payload/consent/key/query), 401 (starter key),
404 (route), 413 (over 16 KiB for business requests / 8 MiB for reports), 415 (content type), 503 (Mapbox key absent only in a custom Mapbox integration).
After a timeout the write may have succeeded; inspect booking status or resend
the same confirmed action with the same idempotency key.

## Manual requests

Run `npm run example:search -- ./my-search.json` for a local search; see README
for its manual caller configuration. The [Postman collection](postman_collection.json)
targets the **upstream voice API directly** and uses `VOICE_INTEGRATION_SECRET`,
not the local starter key. See [voice-integration.md](voice-integration.md) for
curl, Postman and booking instructions.
