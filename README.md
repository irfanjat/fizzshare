# FizzShare

**Send a file from your phone to a laptop with nothing in between.** No account, no upload bar, no "file too large" error. You pick the files, you get a link (and a QR code), the other person opens it, and the bytes go straight between the two devices. Close the tab and the transfer is gone — because there is nowhere it was ever stored.

Live right now: **https://52.4.112.224.sslip.io/**

I built this for a Computer Networks course, but the interesting part was never the UI. It was making two browsers on two completely different networks actually find each other — and then making that failure mode visible instead of mysterious.

---

## Why it's built this way

The whole design follows from one decision: **the server is allowed to talk, but never to carry the file.**

That sounds like a constraint, but it's the reason this runs on a `t2.micro`. The server does exactly two jobs:

1. **Signaling** — swap SDP offers/answers and trickle ICE candidates over a WebSocket. A few kilobytes per session.
2. **TURN relay** — only when the two peers genuinely cannot reach each other. And even then it only ever sees DTLS ciphertext, which it cannot decrypt.

Everything else — the file bytes — goes browser-to-browser over UDP. Upload a 4 GB file or a 40 MB file; the server does the same amount of work. The only case where my server burns bandwidth is the worst case: two peers behind symmetric NAT with no other option, where the relay carries the traffic.

The result is that a transfer can't be scaled *into* the server, can't be rate-limited by it, and can't be read by it.

## What actually travels between the browsers

```
your files  →  16 KiB chunks + 6-byte header
             →  RTCDataChannel (DCEP)
             →  SCTP            reliable, ordered, congestion-controlled
             →  DTLS 1.2/1.3    AES-128-GCM, self-signed certs
             →  UDP             host → srflx → relay candidates via ICE
             →  the other device
```

Two things I like about this stack:

- **SCTP instead of TCP.** Reliable and ordered like TCP, but it runs over UDP, so there's no TCP-over-TCP meltdown if TURN has to relay it.
- **The relay can't read anything.** DTLS encrypts every packet end-to-end, so "our server was in the middle" never becomes "our server saw your file."

Both ends hash every file with SHA-256 when it lands. If the digests don't match, the UI says so out loud instead of quietly handing you a corrupt download.

## The hard parts (the part I'd actually defend in an interview)

**One-sided ICE almost broke every cross-device transfer.** Trickled ICE means each side gathers candidates and ships them over the signaling channel. I'd wired that callback for the sender only. The sender's candidates reached the receiver; the receiver's candidates were silently dropped. Two desktops on the same network connected fine — which is exactly why it looked healthy. The moment real devices were involved, every connection stalled in `checking` forever. The fix is one line, and the lesson wasn't: *a demo on your own LAN is not evidence that networking works.*

**TURN was dead, and quiet about it.** coturn had been started with `--static-auth-secret=`, `--realm=`, `--external-ip=` — all three empty, because the values came from shell interpolation that never ran. It accepted no allocations and logged nothing alarming. Direct paths still worked, so again: invisible until you needed the fallback. Now the compose override is asserted from the same env file the server reads its secret from, and cross-NAT relay is a passing test rather than an assumption.

**Nobody is going to click a button to fail a transfer, so it fails itself.** ICE failures trigger a renegotiation with a hard cap — two restarts, then it gives up and says so, instead of looping forever and melting the battery.

**Backpressure is the difference between "works on my laptop" and "works."** Chunks are 16 KiB and the sender waits for `bufferedAmount` to drop below a low-water mark before queueing more. Without it, a fast sender on a slow link just builds an unbounded queue in browser memory and the tab dies on a big file.

**A share link is a public URL, so the room has manners.** Rooms cap at 2 peers, expire after an hour, lock for 60 seconds after 5 failed joins (so codes can't be brute-forced), and the signaling server rate-limits both messages and join attempts. Payloads over 1 MiB are rejected outright, and every inbound message goes through a validator that rejects malformed SDP, junk ICE candidates, and unknown message types before it reaches a room.

## What's in here

| | |
|---|---|
| **Client** | TypeScript (strict), no framework — ~2.5k lines, bundled with esbuild. A vanilla UI with a fizzy-soda theme: rising bubbles, lime-mint gradient, share-link QR rendered locally from a vendored MIT encoder so it never calls out to a CDN. |
| **Server** | Node + Express + `ws`. Room registry, signaling, TURN credential minting (HMAC, TURN REST style, time-limited usernames), Prometheus metrics, health checks. |
| **Transport** | WebRTC with a self-hosted coturn as both STUN and TURN. Time-limited TURN credentials minted per session, so a browser never holds a long-lived relay secret. |
| **Safety** | Both sides show their DTLS certificate fingerprint as a short code. Read them out loud to each other and you've done manual authentication — if they match, no one swapped certificates in the middle. |
| **Inspector** | A live network panel: the selected candidate pair, RTT trend, throughput, packet loss, DTLS state, and the full candidate list. Toggle host-only or relay-only mid-connection and watch it re-gather — the fastest way I've found to *show* someone what TURN is for. |
| **Mobile** | Screen Wake Lock so transfers don't die when the tab is backgrounded, and auto-download into the browser's own downloader. |
| **Infra** | Docker Compose (signaling + coturn + Caddy with automatic TLS), Terraform for the AWS deployment, Prometheus/Grafana scaffolding. |

## Verifying it actually works

```
client   typecheck clean · 16/16 unit tests
server   28/28 unit tests
E2E      headless Chrome drives the whole flow
```

The E2E run (`client/test/e2e/full.mjs`) isn't a smoke test that "the page rendered." It picks a real file through the actual file input, creates a room, reads the share link, confirms the QR matrix was genuinely painted, opens the link in a second tab, waits for the transfer to complete, and then re-hashes the file that landed on disk to prove it's byte-identical to the source. It passes against both a local server and the live deployment.

## Run it yourself

```bash
cp infra/.env.example .env      # set PUBLIC_HOST, ORIGINS, TURN_SHARED_SECRET
docker compose -f infra/docker-compose.yml up --build
```

Or without TLS and coturn, for poking at the code:

```bash
cd server && PORT=9090 npm run dev
cd client && npm run watch      # esbuild, rebuilds on save
```

Tests: `cd client && npm run typecheck && npm test` · `cd server && npm test`

## Deeper reading

I wrote these while building it, and they're the docs I'd hand a reviewer:

- [Architecture](./docs/01-architecture.md) — components, control vs data plane, and why each decision was made
- [Protocol stack](./docs/02-protocol-stack.md) — layer by layer, UDP → ICE, with the reasoning
- [Sequence diagram](./docs/03-sequence-diagram.md) — the full offer/answer/candidate/transfer flow
- [Folder structure](./docs/04-folder-structure.md) — layout and the traps worth knowing about
- [Signaling server](./docs/05-signaling-server.md) — rooms, limits, TURN credentials
- [Frontend + transfer](./docs/06-frontend.md) — chunking, backpressure, resume, hashing
- [Network Inspector](./docs/07-network-inspector.md) — reading `getStats()` and the policy toggles
- [Deployment](./docs/08-deployment-docker-compose.md) — coturn, Caddy, TLS, AWS
