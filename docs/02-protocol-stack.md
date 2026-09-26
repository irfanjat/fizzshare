# 02 — Protocol Stack (WebRTC DataChannel)

This is the single most important thing to be able to explain in the viva: **exactly what bytes travel between
the two browsers, and at what layer, for a file transfer.**

## 1. The full stack, bottom-up

```
  Application   ┌────────────────────────────────────────────────────────────┐
                │  Custom JSON framing:  {type, seq, offset, data, hash...}  │
                ├────────────────────────────────────────────────────────────┤
  WebRTC        │  RTCDataChannel  (DCEP: Data Channel Establishment Protocol)│
                ├────────────────────────────────────────────────────────────┤
  Transport     │  SCTP  (Stream Control Transmission Protocol)               │
                │    • ordered, reliable channels (streams)                    │
                │    • connection-oriented, message-based                      │
                │    • congestion control (RFC 4960 + RFC 8260 partial)        │
                ├────────────────────────────────────────────────────────────┤
  Security      │  DTLS 1.2/1.3  (Datagram TLS)                                │
                │    • per-packet encryption + integrity (AEAD: AES-128-GCM)  │
                │    • X.509 self-signed certs, fingerprint exchange           │
                ├────────────────────────────────────────────────────────────┤
  Transport     │  UDP  (user datagrams, 1200-ish MTU, no retransmission)     │
                ├────────────────────────────────────────────────────────────┤
  NAT / FW      │  ICE  (Interactive Connectivity Establishment, RFC 8445)     │
                │    host → server-reflexive → relay candidate negotiation     │
                │    STUN connectivity checks (STUN = RFC 5389/8489)          │
                │    TURN relay allocation (RFC 8656) if direct fails          │
  Internet      └────────────────────────────────────────────────────────────┘
```

## 2. Layer-by-layer reasoning

### 2.1 UDP — the brick that makes P2P possible
- UDP has **no session state** at the NAT/firewall, which is exactly why it survives NAT traversal better than TCP.
- A UDP socket binding on port P in the browser creates a NAT mapping; STUN lets us discover the public `ip:port`
  that mapping maps to, and we can predict/relate that mapping for the candidate-pair checks.
- Pitfall we must respect: **UDP datagrams larger than the path MTU get fragmented or dropped**. WebRTC + SCTP
  handles this internally, but our custom chunking (16 KiB) must be *resegmented* by SCTP into MTU-sized packets,
  not trusted to fit one datagram.

### 2.2 DTLS — confidentiality, integrity, and identity
- DTLS = TLS adapted for UDP: adds explicit sequence numbers, retransmission of handshake flights, and reassembly,
  because UDP does not guarantee ordering.
- Each browser generates a self-signed X.509 certificate. The **SHA-256 fingerprint** of that certificate is what we
  show as the "safety code". If the two users read identical codes to each other, they know no one in the middle
  swapped certificates — this is the manual out-of-band authentication ("key continuity" style).
- After handshake: every SCTP packet is wrapped in a DTLS record, encrypted with AEAD, so **packet loss is just a
  dropped datagram; confidentiality is guaranteed even if the TURN relay forwards it**.

### 2.3 SCTP — the "TCP done right" over UDP
- SCTP gives us the same guarantees TCP gives HTTP (reliable, ordered, in-order delivery) **without** opening a TCP
  connection or dealing with TCP-over-TCP problems (which would collapse if TURN relayed TCP inside DTLS).
- Multiple "streams" inside one association → we can (in a future version) give metadata and chunks separate
  streams. We keep two streams: control + data.
- Congestion control: SCTP does its own slow-start / congestion avoidance, so throughput is fair to other traffic on
  the path and avoids melting the user's home NAT.
- **Reliability is end-to-end.** Because SCTP does retransmission inside DTLS over the peer-to-peer path, lost
  packets are retransmitted *only between the two browsers* — the server (even a TURN relay) never sees a classic
  TCP-style connection state machine that would break under asymmetric routing/NAT.

### 2.4 ICE — the NAT traversal brain
- Candidates are collected:
  1. **host** — the LAN address the machine thinks it has (e.g. `192.168.1.10:54321`).
  2. **server-reflexive (srflx)** — the public `ip:port` learned from a STUN binding response.
  3. **relay** — a `ip:port` allocated on the TURN server that allocates UDP relays on demand.
- Two candidates (one from each peer) form a **candidate pair**; ICE performs **connectivity checks** — STUN
   binding requests on the actual media socket — and picks the highest-priority pair that actually works
   (typically: direct UDP > NAT-adjusted UDP > TURN relay).
- Reliability: checks run on a timer until a pair validates; failed pairs are discarded, so ICE always falls
  through srflx → relay. If *every* pair fails, connection fails (this is our "failure demo" when TURN is disabled).

### 2.5 WebRTC DataChannel (DCEP)
- The DataChannel protocol is just framing on top of SCTP. It also negotiates parameters via SCTP (DATA_CHANNEL_OPEN,
  ACK, etc.) and lets us set options — here `ordered: true`, `reliable: true`.
- Why `ordered + reliable`: easiest to explain, and the retransmit/congestion control makes multi-GB transfers work
  without the app-crash risk of hand-rolled UDP recovery. (Trade-off noted for the report: ordered delivery can
  head-of-line-block after a loss burst; throughput over high-loss WAN is the same comparison we will measure.)

## 3. One packet, top to bottom (as seen on the wire)

```
  [ Ethernet ]  [ IP src=A:port  dst=B:port ]  [ UDP ]  [ DTLS record | AES-128-GCM ]
        [ SCTP chunk | DATA | ordered stream 0, TSN 1234 ]
            [ DataChannel payload | {seq: 42, len: 16384, ...} ]  ← our header in the 16 KiB chunk
```

## 4. Why this specific stack and not the alternatives

| Alternative | Why we don't use it |
|---|---|
| HTTP upload → server → HTTP download | Server sees and stores the file; bandwidth math is O(file) on the server; free-tier impossible. |
| Raw WebSocket direct binary (no WebRTC) | Impossible: a WebSocket server is needed on at least one side; browsers can't listen for inbound WebSocket connections, so there's no P2P at all. |
| WebRTC but unordered/unreliable DataChannel | Unordered is fine for chat/telemetry but ruins file integrity; we'd have to reimplement SeqNak + reassembly in app code anyway, and head-of-line is exactly what ordered SCTP does for us. |
| TCP hole-punching (no TURN) | Works only for easy NATs; TCP hole punching is unreliably supported through symmetric NAT / firewalls, and browsers forbid raw TCP sockets. UDP+ICE+TURN is the robust, standard approach. |

## 5. Where the security guarantees actually live

| Guarantee | Mechanism | Layer |
|---|---|---|
| File encrypted in transit | DTLS AEAD (AES-128-GCM) between peer certs | Crypto |
| Relay can't read data (even when unavoidable TURN is used) | TURN forwards ciphertext only; keys never leave browsers | Crypto |
| No MITM on signaling → no swapped certs | Compare fingerprints out-of-band (safety code) | Identity |
| Is it *really* P2P or relayed? | `selectedCandidatePair` type in getStats (tells you live) | Observability |