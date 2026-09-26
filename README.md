# FizzShare — Direct P2P File Sharing over WebRTC

Peer-to-peer file transfers over WebRTC (SCTP/DTLS/ICE) with a fizz-soda animated UI. Send files of any size straight from device to device — nothing is stored online. Close your browser and the transfer stops.

- **Brand**: FizzShare (fizzstyle UI, bubbles animation, lime-mint gradient)
- **Technology**: WebRTC/SCTP/DTLS/ICE (code-matched, no abstraction leaks)
- **P2P by default**, falls back to **TURN relay** only when NAT demands it
- **Zero registration**, no server file storage, SHA-256 integrity verified on both sides
- **ToffeeShare-style flow**: select files → create room → get `/c/<CODE>` link + QR code → receiver opens it (auto-accepts)
- **Wake Lock** keeps transfers alive on mobile; browser native downloaders save files
- **Live Network Inspector**: selected candidate pair, RTT, throughput, packet loss, DTLS state, host/relay-only policy toggles

**Live demo**: https://52.4.112.224.sslip.io/

## Quick local run

```bash
# build + start (Docker Compose)
cp infra/.env.example .env
# set PUBLIC_HOST + TURN_SHARED_SECRET + ORIGINS/SITE_ADDRESS
docker compose -f infra/docker-compose.yml up --build

# dev-only (no TLS, no coturn) — run server on separate port
cd server && PORT=9090 npm run dev
# open http://localhost:9090 (if serving from server/public or run client watch)
```

## Project structure

| Phase | Deliverable | Files | Status |
|---|---|---|---|
| 1 | Architecture, protocol stack, sequence diagram, structure | `docs/01..04` | ✅ done |
| 2 | Signaling server (WS control plane) | `server/` (28/28 tests) | ✅ done |
| 3 | Frontend + WebRTC transfer pipeline | `client/` (16/16 tests, typecheck) | ✅ done |
| 4 | Network Inspector | `client/src/inspector.ts` | ✅ done |
| 5 | coturn + Docker + Compose + Caddy | `turn/`, `infra/docker/`, `infra/docker-compose*.yml`, `infra/Caddyfile` | ✅ done |
| 6 | Terraform (AWS) | `infra/terraform/` | ✅ scaffolding |
| 7 | Prometheus + Grafana | `infra/monitoring/` | ✅ scaffolding |
| 8 | Tests, demos, docs, E2E harness | `client/test/`, `server/test/`, `client/test/e2e/` | ✅ done |

## Tests

```bash
cd client && npm ci && npm run typecheck && npm test        # 16/16
cd server && npm ci && npm test                              # 28/28
```

## E2E

A headless Chrome full flow is included: `client/test/e2e/full.mjs`. It verifies file selection → landing reverts → room creation → share link + QR rendered → cross-tab transfer → SHA-256 verified → download matches source bytes exactly (tested against local server and the live AWS deployment).

## Documentation

- [Architecture](./docs/01-architecture.md)
- [Protocol stack](./docs/02-protocol-stack.md)
- [Sequence diagram](./docs/03-sequence-diagram.md)
- [Folder structure](./docs/04-folder-structure.md)
- [Signaling server](./docs/05-signaling-server.md)
- [Frontend + transfer](./docs/06-frontend.md)
- [Network Inspector](./docs/07-network-inspector.md)
- [Deployment (Docker + coturn + Caddy)](./docs/08-deployment-docker-compose.md)
