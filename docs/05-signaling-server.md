# 05 — Signaling Server

**Location:** `server/` — Node.js 20+, TypeScript, `ws` + `express`, zero other deps.

## 1. What this component is (and is not)

The signaling server is the **control plane only**. It:

- rations room codes (6 chars, unambiguous alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), max 2 peers
- relays SDP offer/answer and trickled ICE candidates between the two peers
- issues time-limited TURN credentials (never file content, never filenames)
- rate-limits joins and messages, locks codes after repeated failed joins
- exposes `/healthz`, `/metrics` (Prometheus text), and serves the built client in dev

It does **not** handle, store, buffer, or log file data. There is no file code in this directory at all.

## 2. Wire protocol (all messages are JSON over WSS)

| Client → Server | Payload | Server → Peer |
|---|---|---|
| `create-room` | — | `room-created {code, peerId, iceServers, expiresAt}` |
| `join-room` | `code` | `room-joined {code, peerId, iceServers, expiresAt}` + `peer-joined` to creator |
| `offer` / `answer` | `sdp` | forwarded verbatim, tagged `from` |
| `ice` | `candidate` | forwarded verbatim, tagged `from` |
| `bye` | — | `peer-left` to survivor |
| `telemetry` | `pairType, rttMs, durationMs, bytes*` | aggregated into Prometheus only |
| — (lifecycle) | — | `room-expired`, `error {error, message}` |

`iceServers` always includes the self-hosted STUN listener; if `TURN_SHARED_SECRET` is configured it also
includes a TURN entry whose `username/credential` were minted for this session.

## 3. TURN REST credentials

```
username   = "<unix-expiry-timestamp>:<random-hex>"
credential = base64( HMAC-SHA1( sharedSecret, username ) )
```

- coturn runs with `use-auth-secret` + `static-auth-secret=<sharedSecret>`; it recomputes the HMAC and checks
  the embedded expiry. No per-user coturn config needed, no long-lived relay password shipped in the browser.
- The server signs a fresh pair for every `create-room`/`join-room`. Lifetime defaults to 3600 s (≥ room TTL),
  so a credential is useless shortly after the session ends and can't be replayed for free relay minutes later.
- If the secret/hostname env is absent, the server still runs — it simply issues STUN-only configs. That is
  your **"why TURN fails" demo**: clients then have only host+srflx candidates (the inspector's policy toggles let
  you force `relay`). See `docs/08` test plan.

## 4. Security decisions (and the reasoning to defend)

| Mechanism | Why |
|---|---|
| Origin check on WS upgrade | Cross-site WebSocket Hijacking: a malicious origin's JS holds no credentials but the browser sends cookies on its behalf. The socket is credentialless, but an attacker site could still make your browser open a socket and *gray-hole* it or trick a user into a fake room. Rejecting unknown `Origin` bins that. |
| Strict per-message validation | `parseClientMessage` is the single entry point for inbound bytes. Malformed types/shapes/oversized SDP are rejected before routing, and the socket is closed (1008). Baggage: message shape is whitelisted, not blacklisted. |
| `maxPayload = 1 MiB`, message + join token buckets | SDP is a few KiB with trickle ICE; candidate floods and repeated bogus joins cost CPU. Per-IP buckets cap both. |
| Room-code lockout | After 5 failed joins on one code (or a TTL of 60 s lock), the code refuses joins. Combined with the ~15 min room TTL this makes brute-forcing a live room infeasible in practice. |
| Never log payloads | Logs record event names + room codes only. SDP contains IPs/fingerprints, ICE candidates contain addresses — none of it is logged. `LOG_LEVEL=debug` adds only control-plane counters. |
| Client telemetry is the **only** post-facto signal about relay vs direct | The server physically cannot observe the data path (it's P2P). `telemetry` messages carry just `pairType/rtt/duration` (no file metadata), so Prometheus can plot *direct vs relay ratio* honestly. |
| IP provenance | `X-Forwarded-For` first hop is trusted because Caddy is the single TLS terminator in front; documented in user guides so people don't run it naked on the internet. |

## 5. Remaining threat model

- **Malicious/injected signaling server** could swap DTLS fingerprints in SDP or replay SDP. Mitigation:
  the two humans compare the safety code (SHA-256 of each peer cert) out-of-band. The server cannot forge
  this without also controlling the data path **both directions**.
- **The room code is the only join gate.** Anyone with it can join and *receive offered files* — which is the
  whole point; the owner of the room controls if/when the receiver is joined and whether to accept.
- **Browser JS supply chain** (compromised npm/build tooling → malicious bundle). Out of scope; noted.
- **Massive relay abuse via stolen credentials**: bounded to credential lifetime + lockouts. Not perfectly
  prevented (TURN inherently burns bandwidth), hence the self-hosted coturn with `min_port/max_port` limits
  from the deployment work.

## 6. Running and testing

```bash
cd server
npm install
npm run dev            # tsx watch, defaults apply (TURN disabled w/o secret)
npm test               # node:test + tsx — 24 tests (turn, rooms, validate, e2e signaling)
npm run build && npm start

# flip on TURN creds:
TURN_HOSTNAME=your.host TURN_SHARED_SECRET=sekret npm start
```

Smoke: `curl localhost:8080/healthz` → `{"status":"ok","activeConnections":0,"activeRooms":0}`

## 7. Files

```
server/
├── src/
│   ├── index.ts        # http/bootstrap, /healthz, /metrics, static, sweeper, graceful stop
│   ├── ws-server.ts    # upgrade/origin checks, heartbeat ping/pong, session lifecycle
│   ├── signaling.ts    # room router: create/join/offer/answer/ice/telemetry/bye
│   ├── rooms.ts        # registry, code gen, expiry, join lockout
│   ├── validate.ts     # strict inbound message parsing
│   ├── turn.ts         # HMAC REST credentials + iceServers payload
│   ├── rate-limit.ts   # token buckets (messages, joins, conns)
│   ├── metrics.ts      # Prometheus text renderer (no deps)
│   ├── config.ts       # env-driven config
│   └── logger.ts       # structured JSON, no payloads
└── test/               # turn / rooms / validate / signaling (e2e over real TCP)
```