# 07 — Network Inspector (Phase 4)

**Location:** `client/src/inspector.ts` (+ `stats.ts` collectors), toggle from the "Network trace" heading.

## 1. What it shows (all from `RTCPeerConnection.getStats()`)

| Panel row | Source | What it shows |
|---|---|---|
| Phase | `PeerConnectionManager` event stream | the state machine you trace |
| ICE / DTLS / Peer Connection / DataChannel state | `pc.iceConnectionState`, transport `dtlsState`, `pc.connectionState`, `dc.readyState` | protocol-stack compliance |
| Buffered (`dc.bufferedAmount`) | DataChannel | backpressure live view |
| Selected path → peer | nominated `candidate-pair` + its local/remote candidates | which pair won |
| RTT + 12-sample trend | `candidate-pair.currentRoundTripTime` | consent/keepalive health |
| Upload / Download B/s | transport `bytesSent/bytesReceived` deltas per poll | real throughput, not progress-bar math |
| Lost pkts / SCTP retx | `transport.packetsLost`, `retransmittedPacketsSent` | retransmission behavior |
| Local / Remote candidate tables | `local-candidate` / `remote-candidate` | host vs srflx vs relay pool |

Polling is 1 s; throughput comes from byte deltas between polls (`throughputBetween` in `inspector.ts`,
unit-tested) — never from the app's own counters, so it measures the *wire*, not our accounting.

## 2. The candidate-policy toggles (the demo)

`RTCIceTransportPolicy` only accepts `all` and `relay` — there is **no "host" policy** in the WebRTC spec.
So the three buttons map to real, different things:

- **Auto**: `iceTransportPolicy: 'all'`, the servers the signaling server handed out.
- **Relay only**: `iceTransportPolicy: 'relay'` — forces every candidate through TURN. The connection stays up
  even across symmetric NAT/enterprise firewalls, at the cost of relaying all bytes.
- **Host only**: keep `'all'` but hand the peer connection an *empty* `iceServers` list — no STUN (= no public
  refs), no TURN. The pool collapses to host/mDNS candidates, so across a NAT the session **fails** — a live
  illustration of why TURN exists.

### Why a "restart" message, not just a local flag

`iceServers` and `iceTransportPolicy` are fixed at `RTCPeerConnection` construction. A live policy flip therefore
needs a fresh peer connection, and both ends must agree. When either user changes the policy and a session is up:

1. the toggler sends `{type:'restart', policy}` to the peer via the signaling server (validated + relayed
   verbatim, exactly like `offer`),
2. both sides tear down the old `RTCPeerConnection`, rebuild with the new configuration
   (`PeerConnectionManager.reconfigure`), and
3. the offerer recreates the DataChannel and sends a fresh offer; the answerer answers on its rebuilt peer.

Any in-flight transfer is cancelled cleanly first (a rebuild ends the SCTP session), and the app is ready to
send again once the channel reopens. After a host-only flip across a NAT you will see the panel go
`failed` → auto-restart attempts → `closed`, which is exactly the "why TURN" teaching moment.

## 3. Safety / hygiene

- One `getStats()` pass per poll via `collectIceReport` + `sampleStats` (cheap, and never blocks the data path).
- Polling stops when the peer leaves or the room expires (`inspector.stop()`).
- All rendered strings are HTML-escaped; candidate properties come straight from the stats report.
- The panel is collapsed by default on desktop; the toggle in the "Network trace" heading shows/hides it.

## 4. Verification performed (Phase 4)

- `client`: `npm test` → **16/16** (added `inspector.test.ts` for throughput deltas), `npm run typecheck`,
  `npm run build` clean.
- `server`: `npm test` → **25/25** (added restart-relay test), `tsc --noEmit` clean.
- Live smoke: signaling round trip incl. `restart {policy:'relay'}` relayed peer-to-peer correctly.
- Two real browsers: **manual E2E pending** (flip host-only/relay-only mid-session and watch the panel).