# 06 — Frontend & WebRTC Transfer (Phase 3)

**Location:** `client/` (TypeScript, esbuild bundle) → built output in `public/` (served by the signaling server in dev).

## 1. Component map

| File | Responsibility |
|---|---|
| `src/main.ts` | app controller: landing flow, room state, signaling dispatch, transfer pipeline wiring, event log |
| `src/signaling.ts` | WebSocket client with auto-reconnect + `setRejoin` replay of create/join |
| `src/connection.ts` | `RTCPeerConnection` lifecycle: trickle-ICE queue, offer/answer, ICE restart, DataChannel handoff |
| `src/protocol.ts` | wire types for the peer channel: JSON control + binary chunk framing |
| `src/sha256.ts` | incremental SHA-256 (pure TS) for end-to-end file verification |
| `src/sender.ts` | upload side: two-pass (hash then send), backpressure-aware chunk pump |
| `src/receiver.ts` | download side: ordered chunk sink, incremental hash verify, orphan guard |
| `src/filesink.ts` | File System Access API streaming sink, memory Blob fallback |
| `src/stats.ts` | `getStats()` sampling (feeds Phase 4 inspector + telemetry) |
| `src/ui.ts` | DOM helpers, formatting, upload speed Welford speedometer |

## 2. Peer channel framing

Control messages are JSON. Bulk data rides a single DataChannel with **ordered delivery**:

```
binary chunk = [ uint16 type=0x0003 ][ uint32 seq ][ 16 KiB payload ]
```

Because the channel is `ordered: true` (SCTP stream with reliable + in-order delivery), the receiver does **no
reassembly** — chunks arrive in sequence order and are written straight to the sink. `seq` is still tracked to
detect gaps/duplicates (paranoid check) and to resume after an ICE restart.

## 3. Transfer flow

```
sender                   receiver
  |  meta{file...,sha256}    |
  |------------------------->|   auto-accept (link-opened flow)
  |  <- accept               |   (no accept/reject modal)
  |  file-start              |
  |  chunk seq=0..N          |   streamed to memory Blob sink
  |  file-end                |
  |  done{verified}          |   incremental hash checked against meta
  |<-------------------------|   ok/corrupt surfaced; telemetry sent
```

Sender runs **two passes** over the file: pass 1 streams the whole file through `Sha256` to learn the digest
(populates the progress bar / hash meta), pass 2 streams + chunks it out. This gives the receiver a pre-transfer
hash without buffering the file in memory.

## 4. Backpressure

Untamed, `send()` never blocks — buffered bytes balloon and the browser OOMs. Our pump:

- after each send batch, waits until `bufferedAmount ≤ 1 MiB` (`bufferedAmountLowThreshold`), else yields to the
  event loop with a 250 ms ceiling so IPC/rendering stay responsive
- soft cap: never lets `bufferedAmount > 8 MiB` before yielding
- pause/resume gate honored between waits; cancel clears state and closes the channel

Pipe throughput governs overall rate: if the receiver's disk or the peer's link is slow, SCTP flow control fills
the send buffer, the threshold trips, and the pump idles. No hand-rolled ACK scheme needed — that is exactly what
SCTP already provides.

## 5. Sink selection

Incoming chunks are buffered in memory as one growing `Blob`; when the transfer completes, the app hands the blob to
the browser's **native downloader** (one `URL.createObjectURL` + `<a download>` click). That is the same UX as
ToffeeShare: files land in the user's Downloads folder, no prompts, and it works when a peer opens the share link
with zero interaction. Received blobs stay available in the page (`#received-files`) for re-download until the tab
closes. Over 512 MiB the UI warns the browser will hold the file in RAM.

StreamSaver-style service-worker streaming or File System Access (`showSaveFilePicker`) are intentionally **not**
used (documented limitation) so the flow stays prompt-free and unattended, matching the link-share model.

## 6. Error handling & self-healing

- **ICE failure**: `iceConnectionState === 'failed'` → offerer calls `pc.restartIce()` and re-offers; answerer
  applies the re-offer. Sender resumes from the last `seq` written; receiver discards a partial file if the sink
  cannot be rewound (stream sink), only when bytes were already written.
- **Signaling flaps**: WS reconnect replays `create-room`/`join-room` so a server bounce mid-session self-heals.
- **Shaky path**: `disconnected` is surfaced in the inspector, not treated as terminal; SCTP retransmits.
- **Hash mismatch**: `done{verified:false}` — receiver keeps the file (better than nothing) but labels it corrupt.

## 7. Security notes (client side)

- No file data ever touches the signaling server; the WebSocket JSON traffic is size-bounded overhead only.
- Room identity = 6-char code (~10^10 candidates), generated server-side, rate-limited joins, lockout after 5
  failures (see `docs/05`).
- The client only dials ICE servers handed to it by the signaling server it is already connected to (same-origin `/ws`).
- Localhost is a secure context in Chrome/Firefox, so plain-HTTP dev still gets `showSaveFilePicker` + WebRTC.

## 8. Verification performed (Phase 3)

- `client`: `npm test` → **11/11** (introduced during phase: incremental SHA-256; boundary, split, fuzz vectors)
- `client`: `npm run typecheck` (tsc strict) and `npm run build` → `public/app.js` (~29 kB)
- `server`: `npm test` → **24/24** (base URL moved to `/ws` after upgrade path check), `tsc` clean, live smoke:
  `/healthz`, static `/`, `app.js`, `/metrics`, full create-room → join-room → peer-joined round trip
- Two real browsers / two devices: **manual E2E pending** (needs one-to-many LAN or two devices)