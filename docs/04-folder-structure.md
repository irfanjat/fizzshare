# 04 — Folder Structure & Design Decisions

```
peershare/
├── client/                          # Frontend (vanilla TypeScript, served statically)
│   ├── index.html
│   ├── style.css
│   └── src/
│       ├── main.ts                  # bootstrap, page logic
│       ├── signaling.ts             # WebSocket client, reconnect w/ backoff
│       ├── webrtc.ts                # RTCPeerConnection lifecycle, ICE restart
│       ├── datachannel.ts           # framing, seq numbers, send loop
│       ├── sender.ts                # file pick, hashing, chunking, backpressure
│       ├── receiver.ts              # accept, reassembly, streaming to disk
│       ├── hashing.ts               # incremental SHA-256 via WebCrypto SubtleCrypto
│       ├── inspector.ts             # getStats sampler, candidate/type/RTT/state
│       └── ui.ts                    # DOM helpers, progress, toasts, rooms
├── server/                          # Signaling server (Node.js)
│   ├── src/
│   │   ├── index.ts                 # entry, graceful shutdown, health endpoint
│   │   ├── ws.ts                    # WebSocket upgrade, origin check, framing
│   │   ├── rooms.ts                 # in-memory room registry, expiry sweeper
│   │   ├── signaling.ts             # message routing (offer/answer/ice/bye)
│   │   ├── auth.ts                  # rate limit, brute-force guard
│   │   ├── turn.ts                  # time-limited TURN creds (HMAC REST API)
│   │   ├── metrics.ts               # Prometheus counters (rooms, conns, ice)
│   │   ├── logger.ts                # structured JSON logs, no file metadata
│   │   └── config.ts                # env-driven config
│   └── package.json
├── turn/
│   └── turnserver.conf               # coturn STUN/TURN config (REST secret injected at runtime)
├── infra/
│   ├── docker/
│   │   ├── Dockerfile.server         # multi-stage: client build → server build → thin runtime
│   │   └── coturn.Dockerfile         # pinned coturn image + self-signed turns: keypair
│   ├── docker-compose.yml            # caddy + signaling + coturn (single-node prod)
│   ├── Caddyfile                     # HTTPS/WSS reverse proxy, ACME, security headers
│   └── .env.example                  # template for the deployment secret set
│   ├── terraform/
│   │   ├── main.tf                  # AWS provider, EC2 (free tier), SG, EIP
│   │   ├── security-groups.tf       # 80/443/tcp, 3478/udp+tcp, 5349/udp+tcp, 49152-65535/udp
│   │   ├── outputs.tf
│   │   └── variables.tf
│   └── monitoring/
│       ├── prometheus.yml
│       └── grafana-dashboards/
├── .github/workflows/
│   ├── ci.yml                       # build client+server, unit tests, lint
│   └── deploy.yml                   # build images, terraform plan/apply, remote deploy
├── scripts/
│   ├── bench.mjs                    # throughput benchmark (direct vs relay)
│   ├── capture.md                   # Wireshark guide + display filters
│   └── demo.sh                      # 1-command local demo (compose up)
├── docs/
│   ├── 01-architecture.md
│   ├── 02-protocol-stack.md
│   ├── 03-sequence-diagram.md
│   ├── 04-folder-structure.md
│   └── 08-...                        # (phases 5-8 add: testing-plan, report-outline…)
└── README.md
```

## Why these boundaries

- **client / server split at the `ws` boundary is deliberate**: the server never imports any file-handling code,
  so there is *nothing* for it to leak even if it wanted to. Files live only inside `.ts` browser modules.
- **`turn/`, `infra/`, `scripts/` are separate from app code**: coturn, Caddy, Terraform, and Prometheus configs
  are ops artifacts; keeping them in one repo means the whole deployment is reproducible with `docker compose up`,
  and the report can cite *official configs, not app scripts*.
- **STM hardware isolation**: hashing, chunking, and datachannel are separate modules so the "transfer" protocol and
  the "UI" can be tested independently; and so the challenge of chunked-file-transfer is visible in the diff.
- **Inspector lives in `inspector.ts`, not folded into `ui.ts`**: the panel queries `getStats()` in a fixed
  500 ms interval and renders text row; keeping the sampler pure makes it unit-testable and stops UI redraws from
  corrupting the throughput math.

## Pitfall inventory (call these out in the report)

1. **Windows/mobile will not listen to `onicecandidate` last candidate if you forget `candidate:''` (end-of-candidates)**.
   We send the explicit end marker and also rely on trickle cues during `setLocalDescription`.
2. **TURN ports blocked by cloud firewall** (the classic): coturn's relay port range `49152-65535/udp` must be open
   in BOTH the OS firewall and AWS Security Group or relay candidates pass ICE checks but every subsequent packet is
   silently dropped → "connected but no data". We will script a UDP probe in `scripts/` to verify.
3. **`bufferedAmount` throttling is mandatory for multi-GB**: files are sliced; the sender loop checks
   `bufferedAmount` (≥ 8 MiB → pause, < lowWater mark → resume) so the memory footprint stays O(one chunk window),
   not O(whole file).
4. **Mobile browser quirks**: iOS Safari kills background tabs (chunks stall when the tab is backgrounded);
   File System Access API is Chrome/Edge only (we implement a `showSaveFilePicker` + MediaSource/StreamSaver
   detection with a `<a download>` + Blob fallback and filesize warnings); `browser-compat` note on `getStats`
   differences (Chrome vs Firefox field names).
5. **`iceServers` TURN creds must be time-limited, not static**: hardcoding a long-lived credential in the JS bundle
   lets anyone use your relay for free; the HMAC/REST method (`username = expiry:userid`, `credential =
   base64(HMAC-SHA1(sharedSecret, username))`) gives coturn-scoped, timestamped creds.
6. **Never `await` file reads inside the send loop**: use a `ReadableStream` reader; `await reader.read()` is only
   awaited when `bufferedAmount < threshold` — otherwise you serialize the whole file into the SCTP queue.
7. **Internet-facing WSS is required**: WebRTC runs only in a *secure context*; a plain-http host will silently miss
   `RTCPeerConnection`, so Caddy must terminate TLS and upgrade `ws://` to `wss://` (http→https redirect).
8. **Test on two distinct NATs, not two tabs + localhost**: loopback hides the difference between host vs srflx vs
   relay because loopback candidates beat everything. The live demo has to use two physical networks.