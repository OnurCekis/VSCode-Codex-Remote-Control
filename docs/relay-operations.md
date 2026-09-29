# Hosted relay operations and self-hosting

The public preview uses a Cloudflare Worker + Durable Object relay. It has no SLA. Both desktop and Android make outbound WSS connections; no inbound port is opened on the user's computer.

## Data boundary

- One desktop socket and one mobile socket are allowed per room.
- Application frames are opaque and end-to-end encrypted.
- Frames are capped at 128 KiB.
- Commands are not queued when a peer is offline.
- The relay retains only the desktop credential hash and optional FCM token needed for the live room.
- Inactive room metadata is deleted after 30 days.
- Authorization headers, room IDs, FCM tokens, and payloads must never be logged.

## Abuse and budget controls

`/healthz` is public and exempt from connection throttling. Other connection attempts use the Cloudflare Rate Limiting binding at 30 attempts per source IP per minute and return HTTP 429 when exhausted. Missing production IP attribution also fails closed.

Cloudflare's free-plan limits can change; consult the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) documentation. Configure usage and budget alerts in the Cloudflare dashboard. If the daily allowance or another platform limit is exhausted, clients must show disconnected/offline and must not fall back to an untrusted relay or queue commands.

## Self-host

1. Create a Cloudflare account and install/authenticate Wrangler locally.
2. Review `apps/pocket-relay/wrangler.toml` and choose a unique Worker name and rate-limit namespace ID.
3. Deploy from `apps/pocket-relay` with `npm ci` and `npx wrangler deploy`.
4. If push is required, set `FIREBASE_PROJECT_ID` as a variable and `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` with `wrangler secret put`. Never commit `.dev.vars` or service-account files.
5. Build the desktop app with the `POCKET_RELAY_URL` build setting pointing to the resulting `wss://` endpoint. Debug and production deployments should use different namespaces.

The public desktop build uses the hosted preview endpoint defined in its macOS build configuration. Self-hosters are responsible for Cloudflare/Firebase costs, incident response, deletion requests, and their own privacy notice.
