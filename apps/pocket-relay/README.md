# VS Code Codex Remote Control Relay

Cloudflare Worker + Durable Object relay for Codex Pocket Android. The relay only forwards live opaque frames and never queues Pocket commands or Codex content.

Production deployment requires a dedicated Cloudflare account/domain. Authenticate with Wrangler outside the repository, set production variables/secrets in Cloudflare, then deploy from this directory. Do not commit `.dev.vars`, service-account material, Android signing keys, or Firebase credentials.

Both peers connect to `/v1/rooms/<high-entropy-room-id>/connect` using `Authorization: Bearer <credential>` and `X-Pocket-Role: desktop|mobile`. Desktop credentials are first-use pinned inside the room. Mobile authorization remains end-to-end and is decided by the desktop; the relay cannot decrypt pairing or control envelopes.

All connection attempts except `/healthz` use the Cloudflare Rate Limiting binding (30 attempts per source IP per minute). A missing production IP signal or exhausted allowance fails closed with HTTP 429. Room metadata is deleted after 30 inactive days. Application content is never queued or stored.
