# 08 — Deployment: Docker Compose + coturn + Caddy (Phase 5)

This is the whole app as a single-node production stack — one `docker compose up`
brings up signaling + coturn + TLS. Nothing here ever sees file bytes: the data
plane stays peer-to-peer, and coturn only relays DTLS ciphertext when ICE cannot
find a direct path.

## 1. What runs where

```
Browser ──wss/https──▶ Caddy (:80 → :443, ACME certs)
                          │  reverse_proxy signaling:8080
                          ▼
                      signaling  (bridge net, NOT exposed to host)
                          │  mints short-lived TURN REST creds (shared secret)
                          ▼
                      coturn  (host networking)
         STUN 3478/udp+tcp · TURN 3478/udp · turns 5349/tcp · relay 49160-49200/udp
```

- **Caddy** is the browser's *only* origin: HTTP(S)/WSS termination, security
  headers, then forwards everything to the signaling container on the compose
  network. Caddy's automatic ACME provisions public certs for the domain.
- **signaling** stays on the private bridge network — it is never reachable
  directly; clients must traverse Caddy (so the Origin check AND TLS both apply).
- **coturn** uses `network_mode: host` on purpose: relay allocations must bind
  the host's real interfaces (visible proof: it advertised `192.168.1.12`
  above), and mapping 40+ UDP relay ports through bridge-NAT is both fragile and
  un-observable. The 41-port relay range is blind-opened in the firewall.

## 2. Port matrix (host)

| Port / proto | Service | Purpose |
|---|---|---|
| 80, 443/tcp | Caddy | HTTP, HTTPS/WSS (ACME) |
| 3478/udp+tcp | coturn | STUN binding + TURN (UDP & TCP control) |
| 5349/tcp | coturn | `turns:` (TLS) listener — self-signed cert in dev |
| 49160-49200/udp | coturn | relay allocations (open on firewall + cloud SG) |

## 3. Configuration (env, `infra/.env.example`)

| Variable | Meaning |
|---|---|
| `PUBLIC_HOST` | Public domain (browsers + TURN reach it) |
| `SITE_ADDRESS` | Caddy site: `yourdomain` (prod, ACME) or `localhost:80` (local demo) |
| `ORIGINS` | Origin-check allow-list (must match what browsers send) |
| `TURN_SHARED_SECRET` | coturn `--static-auth-secret` AND the secret signaling signs creds with |
| `TURN_REALM` | coturn realm (session identity) |
| `TURN_LIFETIME_SEC` | Credential validity advertised to clients |
| `LOG_LEVEL` | signaling log verbosity |

The secret is **never in the repo or image**: Compose injects it into coturn on
the command line at runtime (`--static-auth-secret=$(TURN_SHARED_SECRET)`); the
array is passed to the pinned Docker image whose `docker-entrypoint.sh` evals
each arg. Signaling matches it via `TURN_SHARED_SECRET` env.

## 4. Run it

```bash
cp infra/.env.example .env        # compose reads ./.env from where you run it
$EDITOR .env                       # set PUBLIC_HOST, SITE_ADDRESS, ORIGINS, secret
docker compose -f infra/docker-compose.yml up --build -d
```

Rootless podman (this dev box) needs high host ports and SELinux relabeling —
already encoded via overridable vars and `:ro,Z` mounts:

```bash
PUBLIC_HOST=localhost SITE_ADDRESS=localhost:80 ORIGINS=http://localhost:8081 \
TURN_SHARED_SECRET=testsecret123 TURN_REALM=peershare.local \
HTTP_PORT=8081 HTTPS_PORT=8443 \
podman compose -f infra/docker-compose.yml up -d --build
# then open http://localhost:8081  (localhost is a secure context for WebRTC)
```

## 5. Verification checklist (all green on this box)

```bash
# app + static + health + metrics through Caddy
curl -so /dev/null -w '%{http_code} ' http://localhost:8081/{,app.js,healthz,metrics}

# signaling control plane: create/join/peer-joined + Phase-4 restart relay,
# and inspect the REST ICE creds the server mints (vanilla WS → Caddy).
# (Ad-hoc `ws` script, not part of the repo — see docs/03 message shapes.)
# Node: connect ws://localhost:8081/ws with Origin: http://localhost:8081,
#   send {"type":"create-room"} → room-created carries
#   stun:localhost:3478 + turn:localhost:3478 + turns:localhost:5349 (REST creds)

# TURN really allocates with those creds (coturn's own client):
#   podman run --rm --network host coturn/coturn:4.6.2 \
#     turnutils_uclient -W <secret> -u <unix-expiry>:<uid> -n 1 -y 127.0.0.1
# coturn logs: "incoming packet ALLOCATE processed, success"
#   + "Local relay addr: <lan-ip>:491xx"  (inside the declared range)
```

Two-browser demo: open the room link in two tabs on this LAN; in the Inspector
press **Relay only** — verify the selected path flips to the `192.168.1.x:491xx`
relay candidate, and **Host only** (empty `iceServers`, policy `all`) fails to
re-gather across NAT — the "why TURN" moment.

## 6. Security decisions (call these out in the report)

- Time-limited TURN REST creds: coturn `use-auth-secret`, not `lt-cred-mech` —
  a leaked bundle leaks a future-dated token, not a long-lived one (`config.ts`,
  `turn.ts`).
- Relay is not an open proxy: `denied-peer-ip` blocks loopback, CGNAT, and RFC
  1918 destinations. Our alloc test hit `403 Forbidden IP` when relaying to
  127.0.0.1 — hardening verified working, by accident.
- No TLS 1.0/1.1 anywhere (`no-tlsv1`, `no-tlsv1_1`); `fingerprint` on all STUN.
- CSP/HSTS/X-Frame-Options/Referrer-Policy set at the edge (Caddy), so the app
  can never be framed or downgraded; `connect-src 'self' wss: ws:` is all WebRTC
  needs.
- Origin check is the signaling server's own admission control (only listed
  origins may open the WebSocket).

## 7. Cloud (Phase 6 will wire this)

On EC2 behind SNAT with an Elastic IP, coturn must advertise the EIP in relay
candidates — Compose/podman user-data will inject `--external-ip=<EIP>`, and the
Security Group opens 49160-49200/udp (docs/04 pitfall #2). Local: no change
needed; relay-ip auto-detects the interface.

## 8. Operational notes

- **Serving the app**: the runtime image is served *from the signaling
  container*, copied from the client build stage — so Caddy proxies one upstream
  and there is no static/CDN split. `config.publicDir` walks `dist/../public`
  (packaged) or `src/../../public` (tsx dev) so the same lookup works in both.
- **coturn TLS listener** uses a self-signed cert generated at image build; only
  `turns:` URL is affected (browsers will fail TLS there). Real TURN in dev is
  UDP (3478) — unaffected.
- **Logging**: coturn writes to stdout (`log-file=stdout`), signaling logs JSON
  per event to stdout — both surface in `docker compose logs`.