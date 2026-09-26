# peershare — Direct P2P File Sharing over WebRTC

Server-free, browser-to-browser file transfer (ToffeeShare-style) built for a Computer Networks term project.

- Code-matched, real WebRTC/SCTP/DTLS/ICE stack (no abstraction leak)
- Direct P2P by default; TURN relay only when NAT demands it
- No signup, no size limit, no server file storage
- ToffeeShare-style link sharing: sender picks files → gets `/c/<CODE>` share link → receiver just opens it; accept and send are automatic, Wake Lock keeps the screen on, per-file SHA-256 verification, browser-downloader save
- Live Network Inspector (selected candidate pair, RTT, throughput, loss, DTLS state)
- Full deployment: coturn + Node signaling + Caddy TLS + Docker Compose + Terraform (AWS free tier)

**Status — running in phases.**

| Phase | Deliverable | Files | Status |
|---|---|---|---|
| 1 | Architecture, protocol stack, sequence diagram, structure | `docs/01..04` | ✅ done |
| 2 | Signaling server | `server/` (24 tests, build+smoke verified) | ✅ done |
| 3 | Frontend + WebRTC transfer | `client/` (16/16 tests, typecheck+build verified) | ✅ done |
| 4 | Network Inspector | `client/src/inspector.ts` (16/16 tests; host/relay-only toggles) | ✅ done |
| 5 | coturn + Dockerfiles + Compose + Caddy | `turn/`, `infra/docker/`, `infra/docker-compose.yml`, `infra/Caddyfile` | ✅ done |
| 6 | Terraform + CI/CD | `infra/terraform/`, `.github/` | next |
| 7 | Prometheus + Grafana | `infra/monitoring/` | |
| 8 | Tests, Wireshark guide, benchmarks, report outline, demo | `scripts/`, `docs/` | |

**ToffeeShare-style link flow** is implemented and end-to-end verified in headless Chrome
(two-tab driver at `/tmp/opencode/e2e.mjs`): share link → receiver opens it → auto
connect/accept/transfer → both sides log a matching SHA-256, the browser downloader saves
the file. Try it: open `http://localhost:8081`, pick files, open the `/c/<CODE>` link in
another tab/browser/phone.

## Quick local run

```bash
# deploy (docker or podman):
cp infra/.env.example .env        # set PUBLIC_HOST/SITE_ADDRESS/ORIGINS/TURN_SHARED_SECRET
docker compose -f infra/docker-compose.yml up --build
# rootless podman: prefix env PUBLIC_HOST=localhost SITE_ADDRESS=localhost:80 \
#   ORIGINS=http://localhost:8081 HTTP_PORT=8081 HTTPS_PORT=8443 and open http://localhost:8081

# dev-only (no TLS, no coturn):
cd server && PORT=9090 npm run dev      # 8080 on this box is Jenkins
```

## Read first

- [Architecture](./docs/01-architecture.md)
- [Protocol stack](./docs/02-protocol-stack.md)
- [Sequence diagram](./docs/03-sequence-diagram.md)
- [Folder structure + pitfalls](./docs/04-folder-structure.md)
- [Signaling server](/docs/05-signaling-server.md)
- [Frontend + transfer](/docs/06-frontend.md)
- [Network Inspector](/docs/07-network-inspector.md)
- [Deployment: Docker Compose + coturn + Caddy](/docs/08-deployment-docker-compose.md)