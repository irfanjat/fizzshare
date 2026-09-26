# 01 — Architecture Overview

## 1. What FizzShare does

A **zero-server-resident peer-to-peer file transfer** web app. Two browser tabs (two users) establish a direct
WebRTC DataChannel between them. The only things the server ever does are:

1. **Talking** — exchange SDP offers/answers and ICE candidates over a secure WebSocket (this is "signaling").
2. **TURN** — relay DTLS traffic ONLY when the peers cannot reach each other directly (symmetric NAT / strict
   firewall). Even then, the server only sees ciphertext inside DTLS; it cannot decrypt file content.

The file bytes **never** transit the signaling server. If a host/server-reflexive candidate path works, file bytes
go browser-to-browser over UDP and the server sees nothing but STUN/TURN control traffic.

## 2. High-level component diagram

```
                        +-----------------------------+
                        |             AWS EC2          |
                        |                             |
   +---------+          |   +--------------------+    |          +---------+
   | Browser |          |   |   Signaling Server  |    |          | Browser |
   |  peer A +----------+-->|   (Node.js + ws)    |<---+----------+  peer B |
   | (sender)|  WSS     |   +--------------------+    |   WSS    |(receiver)|
   +----+----+          |   |  STUN/TURN (coturn) |    |          +----+----+
        |               |   +--------------------+    |               |
        |<---------------- DTLS (relay, only when needed) ----------->|
        |<------------------------- DTLS direct (UDP) ---------------->|
        |                                                              |
        +----- STUN binding requests to discover public addr ------>   |
                        +----+----+
                        |  STUN   |
                        | server  |   (can be coturn itself or public STUN)
                        +---------+
```

- **Peer A (sender)** creates a room, gets a 6-char code + link.
- **Peer B (receiver)** joins the room via the link/code.
- Signaling messages S1..S5 (offer / answer / candidates / etc.) flow over **WSS**.
- Media data path (SCTP/DTLS) flows **directly between A and B** when possible.
- coturn's `stun-only` role can serve as the STUN server too (one service, two jobs).

## 3. Why the architecture is the way it is

| Decision | Reasoning |
|---|---|
| WebRTC DataChannel instead of HTTP upload/download | DataChannels are SCTP-over-DTLS-over-UDP: built-in reliability, ordered delivery, and end-to-end encryption; bytes move peer-to-peer, so the server can't scale-limit or inspect file contents. This is exactly why ToffeeShare/ShareDrop-style apps work on free infrastructure. |
| WebSocket signaling | The signaling channel is pure control-plane metadata. WebSocket is message-oriented (no HTTP request/response framing cost) and bidirectional, which is a natural fit for SDP/ICE exchange. TLS (wss) protects signaling and is also required for the browser to grant `RTCPeerConnection` secure-context APIs. |
| Self-hosted coturn for STUN **and** TURN | Public Google/Cloudflare STUN servers are free but unreliable and give no relay capability. Splitting STUN (on 3478/udp) and TURN (3478/udp, 5349/tls + relay range) makes it possible to watch host → srflx → relay candidate progression and measure the relay overhead. |
| Server-generated time-limited TURN credentials | TURN relays are bandwidth you pay for. Authenticating peers with HMAC-signed credentials (the [TURN REST API](https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00) convention) means a browser only gets a short-lived credential for the exact duration of a transfer and credentials can't be leaked from static page bundles. |
| no-third-party-file-APIs, free-tier-only | The whole point of P2P is the server never carries load proportional to file size. One cheap t2.micro can serve unlimited concurrent transfers because traffic is P2P; only TURN-relayed transfers (worst case) consume server bandwidth. |

## 4. Data plane vs control plane

- **Control plane**: WebSocket (WSS/TLS/TCP) — room management, SDP offers/answers, ICE candidate trickling,
  safety-code fingerprints, transfer-control messages (accept, pause, cancel). Cost: a handful of KB.
- **Data plane**: WebRTC DataChannel (SCTP over DTLS over UDP) — file metadata + 16 KiB chunks end-to-end.
  Cost: proportional to file size, but it bypasses the server (except TURN fallback).

This separation is what makes the server failure-proof for large files: **no matter how big the file, the server's
memory/CPU/bandwidth cost stays constant**.

## 5. What the server never sees

- File names (receiver gets file name/size from the *sender peer over the DataChannel*, not from signaling).
- File contents (they never cross the signaling WebSocket; a Wireshark capture of the server shows only SDP/ICE).
- The DTLS session keys (keys are derived client-side in each browser).