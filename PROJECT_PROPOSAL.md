# Project Proposal — PeerShare: Direct P2P File Sharing over WebRTC

**Course:** Computer Networks
**Project Type:** Term Project (implementation + report + demo)
**Author:** _[Your Name]_
**Date:** September 19, 2026

---

## 1. Title

**PeerShare — Direct P2P File Sharing over WebRTC**

A server-free, browser-to-browser file transfer application in the style of ToffeeShare: a sender picks files, gets a short share link, a receiver opens the link, and the file bytes travel end-to-end between the two browsers over a WebRTC DataChannel. The central server never touches, stores, or sees the file content.

## 2. Problem Statement

Classical file transfer on the web is client-server: upload to a server, download from the server. This has three costs that grow linearly with file size:

1. **Bandwidth** — the server must absorb both the upload and the download, so a 2 GB file costs 4 GB of server bandwidth.
2. **Storage** — the server holds the file, which for large or sensitive files is an availability, cost, and privacy burden.
3. **Privacy** — the file passes through (and can be logged by) a third party, even for one-shot transfers between friends.

Free-tier infrastructure (e.g. a single low-cost VM) cannot economically serve large files this way. Yet users routinely need to send large files — photos, videos, installers — without an account or central store.

## 3. Proposed Solution

A **peer-to-peer web application** where file bytes go directly from sender to receiver over the internet, with the server reduced to a thin *control-plane* role:

- **Signaling server** — a small Node.js service that only exchanges SDP offer/answer and ICE candidates over a secure WebSocket. It allocates room codes and issues short-lived TURN credentials.
- **STUN + TURN relay** (coturn) — used only for NAT discovery and as a last-resort relay when two peers cannot reach each other directly (symmetric NAT / strict firewall). Even then, the relay forwards only DTLS-encrypted ciphertext and cannot read the content.
- **Browser client** — the entire data plane. Files are hashed (SHA-256), chunked into 16 KiB pieces, and shipped over a WebRTC DataChannel (SCTP over DTLS over UDP) with automatic backpressure, ordered delivery, and end-to-end integrity verification.

### Key features

- Direct P2P by default; **TURN relay only when NAT demands it**
- **ToffeeShare-style link sharing** — sender picks files → gets `/c/<CODE>` link → receiver opens it; accept and send are automatic
- **No signup, no size limit, no server file storage**, and files download straight into the browser's Downloads folder
- **Per-file SHA-256 verification** at the receiver
- **Wake Lock** keeps the screen on during transfer
- **Live Network Inspector** — shows the selected candidate pair, measured RTT, real throughput, packet loss, SCTP retransmissions, and DTLS state; with *Auto / Relay-only / Host-only* toggles that visibly demonstrate why TURN exists
- **Full production deployment** — coturn + Node signaling + Caddy TLS behind Docker Compose, with Terraform for AWS free tier

## 4. Why WebRTC (Technology Rationale)

We chose the WebRTC DataChannel stack because it is the only browser-native way to get true peer-to-peer file transfer:

| Layer | Role | What we leverage |
|---|---|---|
| UDP | The "hole" through NAT | No session state at firewalls, NAT traversal survival |
| ICE (RFC 8445) | NAT traversal brain | host → server-reflexive → relay candidate negotiation, connectivity checks |
| STUN (RFC 5389/8489) | Discover public address | XOR-MAPPED-ADDRESS for srflx candidates |
| TURN (RFC 8656) | Last-resort relay | Relay allocations only when a direct path fails |
| DTLS 1.2/1.3 | Security | Per-packet AEAD encryption (AES-128-GCM), self-signed certs, fingerprint ("safety code") verification |
| SCTP | Reliable transport | Ordered, reliable streams with built-in congestion control and retransmission |
| DataChannel (DCEP) | Framing | Message-oriented channel with `bufferedAmount` backpressure |

Because SCTP handles reliability *inside* DTLS over the peer-to-peer path, retransmissions happen only between the two browsers — the server (even a TURN relay) never sees a TCP-style connection state machine, and confidentiality holds even on a relayed path.

### Why not the alternatives

| Alternative | Rejected because |
|---|---|
| HTTP upload → server → download | Server sees/stores files; bandwidth grows with file size; free tier impossible |
| Raw WebSocket binary (no WebRTC) | Browsers cannot listen for inbound sockets — there is no P2P at all |
| Unordered/unreliable DataChannel | Breaks file integrity; forced hand-rolled sequence/NACK in app code |
| TCP hole punching (no TURN) | Unreliable through symmetric NAT; browsers forbid raw TCP sockets |

## 5. System Architecture

```
                     +-----------------------------+
   +---------+       |             AWS EC2          |       +---------+
   | Browser |  WSS  |   +--------------------+    |  WSS  | Browser |
   |  Peer A +------->|   Signaling Server    |<-------+  Peer B  |
   | (sender)|        |   (Node.js + ws)      |        | (receiver)|
   +----+----+        |   +--------------------+    |        +----+----+
        |             |   | STUN/TURN (coturn) |    |             |
        |             |   +--------------------+    |             |
        |<--- DTLS direct (UDP) when NAT permits --->|            |
        |<-- DTLS relay (only when direct fails) --->|            |
        |---- STUN binding requests (public addr) --->   +----+----+
        |                                                |  STUN   |
        +---------------------------------------->        +---------+
```

- **Control plane** (WebSocket / secure): room management, SDP offer/answer, trickled ICE candidates, safety-code fingerprints, transfer control. Cost: a few KB.
- **Data plane** (WebRTC DataChannel, end-to-end): file metadata + 16 KiB chunks. Cost: proportional to file size, but it bypasses the server except in the TURN fallback case.

**The server's cost stays constant regardless of file size.** One cheap VM can serve unlimited simultaneous transfers because only the two peers carry the data load.

## 6. Transfer Flow (Sequence)

1. **Room setup** — Peer A connects over WSS, `create-room` → gets a 6-char code + share link + short-lived TURN creds.
2. **Receiver joins** — Peer B opens the link, `join-room` → both sides notified; B receives TURN creds.
3. **ICE gathering** — Both peers collect host, server-reflexive (via STUN), and relay (via TURN) candidates, streaming them as trickle ICE.
4. **Offer/Answer** — A creates the DataChannel and offers; B answers; candidates flow in parallel over signaling.
5. **Connectivity checks** — STUN binding checks select the best working candidate pair (direct UDP > NAT-adjusted > relay). DTLS handshake runs; fingerprint compared against the human-verified "safety code".
6. **Transfer** — A computes SHA-256 (pass 1), then streams 16 KiB chunks with `bufferedAmount` backpressure; B writes them in-order to a memory Blob, streaming into the native browser downloader. On `end`, B recomputes SHA-256 and sends `done{verified}`.
7. **Self-healing** — On ICE failure the offerer calls `pc.restartIce()`, re-offers, and the sender resumes from the last acked sequence number.

## 7. Security & Privacy Design

| Guarantee | Mechanism |
|---|---|
| File encrypted in transit | DTLS AEAD (AES-128-GCM) between peer certificates |
| Relay cannot read data even when TURN is forced | TURN forwards ciphertext only; keys never leave the browsers |
| No MITM on signaling | Both users compare the SHA-256 certificate "safety code" out-of-band |
| Server never sees the file | File names/sizes/hashes travel over the DataChannel, not signaling; the server has no file-handling code at all |
| Limited relay abuse | HTM-signed, time-limited TURN REST credentials (lifetime ≈ room TTL), per-IP rate limits, join lockout after 5 failed attempts, origin check on the WebSocket |
| No long-lived relay secret in the bundle | coturn `use-auth-secret` with per-session usernames |

## 8. Implementation Plan & Deliverables

The project is built deliberately in phases, each with a testable deliverable:

| Phase | Deliverable | Files | Status |
|---|---|---|---|
| 1 | Architecture, protocol stack, sequence diagram, folder structure | `docs/01..04` | ✅ Done |
| 2 | Signaling server (Node.js + ws) — rooms, validation, rate limits, TURN creds, Prometheus metrics | `server/` | ✅ Done (28/28 tests) |
| 3 | Frontend + WebRTC transfer — hashing, chunking, backpressure, downloader | `client/` | ✅ Done (16/16 tests) |
| 4 | Network Inspector — getStats sampler, path/RTT/throughput/loss, candidate-policy toggles | `client/src/inspector.ts` | ✅ Done (16/16 tests) |
| 5 | Production deployment — coturn + Dockerfiles + Compose + Caddy TLS | `turn/`, `infra/docker/`, `infra/docker-compose.yml`, `infra/Caddyfile` | ✅ Done |
| 6 | Cloud — Terraform (AWS free tier) + CI/CD | `infra/terraform/`, `.github/` | Next |
| 7 | Monitoring — Prometheus + Grafana dashboards | `infra/monitoring/` | Planned |
| 8 | Test suite, Wireshark guide, throughput benchmarks, report outline, final demo | `scripts/`, `docs/` | Planned |

### Tech stack

- **Client:** vanilla TypeScript, esbuild bundle (~29 kB), WebRTC + WebCrypto APIs, no framework
- **Server:** Node.js ≥20, TypeScript, `ws` + `express` (zero other runtime deps)
- **Edge/NET:** coturn 4.6.2 (STUN/TURN), Caddy (TLS/ACME reverse proxy)
- **Ops:** Docker Compose, Terraform (AWS), Prometheus text-format metrics
- **Testing:** `node:test` + `tsx`; strict `tsc` typecheck; e2e verified in headless Chrome

### Verification status

- ✅ Server: **28/28** tests green, build + smoke verified (`/healthz`, `/metrics`, full create→join→peer-joined round trip)
- ✅ Client: **16/16** tests green (SHA-256 vectors, boundary/split/fuzz, inspector throughput math), typecheck + build clean
- ✅ End-to-end link flow verified in headless Chrome: share link → receiver opens → auto connect/accept/transfer → both sides match SHA-256 → browser downloader saves the file
- ⏳ Pending: two-browser demo across two distinct NATs (host-only/relay-only toggle demonstration)

## 9. Expected Outcomes & Evaluation Metrics

- **Functionality:** reliable file transfer with hash-verified integrity, download-to-Downloads UX, room-link sharing
- **Performance:** throughput measured on the *wire* (`getStats` byte deltas) under three regimes — host, server-reflexive, and forced TURN relay — to quantify relay overhead
- **Robustness:** large-file stability via backpressure (no O(filesize) memory), ICE-restart resume after path failure
- **Observability:** live Network Inspector plots of RTT, throughput, loss, SCTP retransmits, DTLS state, and the selected candidate path (Auto / Relay-only / Host-only)
- **Deliverables for grading:** this proposal, technical report with protocol-stack and sequence-diagram documentation, unit tests, Wireshark capture guide, benchmark results, and a live demo

## 10. Timeline

| Weeks | Milestone |
|---|---|
| 1–2 | Project setup, architecture + protocol documentation (Phase 1) |
| 3–4 | Signaling server + tests (Phase 2) |
| 5–6 | Frontend transfer pipeline + tests (Phase 3) |
| 7–8 | Network Inspector (Phase 4) |
| 9–10 | Deployment stack: coturn + Compose + Caddy (Phase 5) |
| 11–12 | Cloud (Terraform + CI/CD), monitoring, benchmarks, report, demo |

*(Phases 1–5 are already complete as of submission; remaining phases 6–8 are scheduled.)*

---

## References

- WebRTC DataChannel & ICE: RFC 8445 (ICE), RFC 5389/8489 (STUN), RFC 8656 (TURN), RFC 4960 (SCTP)
- TURN REST Credentials: draft-uberti-behave-turn-rest
- Inspiration: ToffeeShare, ShareDrop (link-based browser P2P file sharing)