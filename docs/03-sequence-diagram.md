# 03 — Sequence Diagram (Mermaid)

Diagram below, and the matching message-by-message walkthrough. This is the artifact to read alongside the walkthrough.

```mermaid
sequenceDiagram
    autonumber
    participant A as Peer A (sender, browser)
    participant S as Signaling Server (Node+ws)
    participant T as STUN/TURN (coturn)
    participant B as Peer B (receiver, browser)

    rect rgb(235,245,255)
    Note over A,S: 1. Room setup (control plane, WSS)
    A->>S: ws connect (TLS)
    A->>S: {type:'create-room', id: uuid}
    S-->>A: {type:'room-created', code:'ABCDEF', turnCreds}
    S-->>T: allocation (TURN), if relay needed
    end

    rect rgb(245,240,255)
    Note over B,S: 2. Receiver joins
    B->>S: ws connect (TLS)
    B->>S: {type:'join-room', code:'ABCDEF'}
    S-->>B: {type:'room-joined', role:'receiver', turnCreds}
    S-->>A: {type:'peer-joined'}
    end

    rect rgb(255,252,235)
    Note over A,B,T: 3. ICE candidate gathering (in parallel with 4)
    A->>T: STUN binding request (discover public srflx addr)
    T-->>A: XOR-MAPPED-ADDRESS
    A->>T: TURN allocate if relay creds issued
    T-->>A: allocated relay addr + perm
    B->>T: STUN binding request
    T-->>B: XOR-MAPPED-ADDRESS
    Note over A,B: host + srflx (+relay) candidates collected, emitted via onicecandidate
    end

    rect rgb(250,235,245)
    Note over A,B,S: 4. Offer/Answer + trickle ICE (SDP via WSS)
    A->>A: new RTCPeerConnection, createDataChannel
    A->>S: {type:'offer', sdp}
    S-->>B: relay offer
    B->>B: new RTCPeerConnection, ondatachannel
    B-->>S: {type:'answer', sdp}
    S-->>A: relay answer
    Note over A,B,S: ice candidates streamed as they appear ({type:'ice', candidate})
    end

    rect rgb(225,245,230)
    Note over A,B,T: 5. Connectivity checks + media path (UDP)
    A->>T: STUN binding (connectivity check via candidate pair)
    T-->>A: STUN binding response
    B->>T: STUN binding (its own checks)
    T-->>B: STUN binding response
    Note over A,B: Highest-priority working pair selected; ICE connected
    Note over A,B: DTLS handshake (fingerprints cross-checked vs safety code)
    Note over A,B: SCTP association + DataChannel open
    end

    rect rgb(255,245,240)
    Note over A,B: 6. File transfer (data plane, end-to-end)
    A->>A: compute SHA-256, chunk file into 16 KiB
    A->>A: slice: stream chunks w/ backpressure (bufferedAmount)
    A->>B: DataChannel msg {type:'meta', name,size,mime,chunkCount,sha256}
    B-->>A: DataChannel msg {type:'accept'}
    loop chunks
        A->>B: DataChannel msg {type:'chunk', seq, idx, data}
    end
    A->>B: DataChannel msg {type:'end', sha256Final}
    B->>B: hash-verify received bytes
    B-->>A: DataChannel msg {type:'done', verified}
    B-->B: stream to disk (File System Access API / fallback)
    end
```

## 7. Walkthrough notes (defensible talking points)

1. **Room code is not a secret.** Anyone who knows the 6-char code can enter the room; that's why the killer
   security property is the **DTLS fingerprint / safety-code check**, not the room code. Room lifetimes are short
   so codes are hard to brute-force *before* the room dies.
2. **Offer/answer must be exchanged before ICE candidates complete** (trickle ICE):
   - Signaling carries candidates **as they fire**, not in a bloated final SDP. The browser fires `icecandidate`
     events one-by-one; each is forwarded as `{type:'ice'}`.
   - The risk ("trickle ICE timing") is if peer B's `onicecandidate` events arrive before A's offer created the
     connection, or if the `icecandidate` handler isn't installed before `createAnswer()` runs. The handler is
     installed at construction time and only adds candidates when the remote description exists.
3. **ICE pick is observable**, not magic: `RTCPeerConnection.getStats().then(s => s.selectedCandidatePair)`
   shows *which* of host/srflx/relay won, where the two ends are, and the measured RTT — this is the Network
   Inspector panel's data source.
4. **DTLS fingerprints**: each side's self-signed certificate fingerprint is sent in the SDP (`a=fingerprint:`).
   That's where a passive/active MITM on signaling could swap fingerprints → the hash is displayed to both humans, and
   they read it aloud to each other over phone/voice. Implementing the comparison is genuinely useful, and doing it
   via getStats (not trusting signaling) is the honest method.
5. **Transfers are relaunch-able**: on any candidate-pair failure the connection is torn down, ICE restarted, then
   the file continues from the last acknowledged chunk sequence number.