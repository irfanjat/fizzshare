/**
 * connection.ts — RTCPeerConnection lifecycle manager.
 *
 * Owns: iceServers config, trickled ICE candidate queue, offer/answer flow,
 * ICE restart on failure, and DataChannel creation (sender) / handoff
 * (receiver). Emits state transitions so the UI (and the network inspector) can
 * show ICE/DTLS/connection states live.
 *
 * Trickle-ICE timing pitfall addressed here: candidates may arrive before the
 * remote description exists (receiver's candidates racing the sender's offer).
 * We queue them and flush once setRemoteDescription() resolves.
 *
 * ICE-restart self-heal: on iceConnectionState==='failed' we call
 * pc.restartIce() and renegotiate from the offerer. Chunked transfer resumes
 * from the last acknowledged sequence number (see sender.ts).
 */

import type { IceServerLike } from './signaling.js';

export type ConnectionPhase =
  | 'idle'
  | 'peer-joined'
  | 'negotiating'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface IceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface ConnectionCallbacks {
  onPhase: (phase: ConnectionPhase, detail?: string, at?: number) => void;
  onDataChannel: (dc: RTCDataChannel) => void;
}

/** Build an RTCConfiguration from the ICE servers the signaling server offered. */
export function makeIceServers(list: IceServerLike[] | null): RTCConfiguration {
  if (!list || list.length === 0) return {};
  return {
    iceServers: list.map((s) => ({
      urls: s.urls,
      username: s.username,
      credential: s.credential,
    })),
  };
}

export class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private myRole: 'offerer' | 'answerer' = 'offerer';
  private candidateQueue: IceCandidateInit[] = [];
  private remoteDescSet = false;
  private icePolicy: RTCIceTransportPolicy = 'all';
  private phase: ConnectionPhase = 'idle';
  /** Guard against a restart/negotiation storm (see MAX_RESTARTS below). */
  private restartInFlight = false;
  private restartAttempts = 0;
  private static MAX_RESTARTS = 2;

  constructor(private readonly events: ConnectionCallbacks) {}

  get channel(): RTCDataChannel | null {
    return this.dc;
  }

  get peerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  get currentPhase(): ConnectionPhase {
    return this.phase;
  }

  public setIcePolicy(policy: RTCIceTransportPolicy): void {
    this.icePolicy = policy;
  }

  /** Sender path: create the DataChannel, then start negotiation. */
  public async startAsOfferer(
    iceServers: RTCConfiguration,
    onChannelEstablished: () => void,
  ): Promise<RTCDataChannel> {
    if (this.pc) throw new Error('already started');
    this.emit('negotiating', 'creating data channel');
    this.myRole = 'offerer';
    this.createPeer(iceServers);
    const dc = this.pc!.createDataChannel('peershare', {
      ordered: true,
    });
    dc.binaryType = 'arraybuffer';
    this.dc = dc;
    void this.channelInitialized(dc).then(onChannelEstablished);
    return dc;
  }

  /** Receiver path: wait for the remote offer + inbound DataChannel. */
  public async prepareAsAnswerer(iceServers: RTCConfiguration): Promise<void> {
    this.myRole = 'answerer';
    if (!this.pc) this.createPeer(iceServers);
  }

  public async handleOffer(sdp: string, sendAnswer: (sdp: string) => void): Promise<void> {
    if (!this.pc) throw new Error('peer not prepared');
    this.emit('negotiating', 'offer received');
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    this.remoteDescSet = true;
    await this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.emit('connecting', 'answer sent');
    sendAnswer(answer.sdp!);
  }

  public async handleAnswer(sdp: string): Promise<void> {
    if (!this.pc) throw new Error('no peer');
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    this.remoteDescSet = true;
    await this.flushCandidates();
    this.emit('connecting', 'remote answer set');
  }

  public async handleIce(candidate: IceCandidateInit): Promise<void> {
    if (!this.pc) return;
    if (!candidate.candidate) return; // end-of-candidates marker
    if (!this.remoteDescSet) {
      this.candidateQueue.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate as RTCIceCandidateInit);
    } catch {
      /* stale candidate after restart — ignore */
    }
  }

  public async createOfferAndSignal(sendOffer: (sdp: string) => void): Promise<void> {
    if (!this.pc) {
      // Offerer always has a pc after startAsOfferer; defender for tests.
      throw new Error('no peer');
    }
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.emit('negotiating', 'offer sent');
    sendOffer(offer.sdp!);
  }

  /**
   * ICE restart after failure: re-gather and renegotiate from the offerer.
   * Enforces its own budget and re-entrancy guard, so it is safe to call once
   * per 'failed' phase. Returns false when no restart was started.
   */
  public async restartIce(sendOffer: (sdp: string) => void): Promise<boolean> {
    if (!this.pc || this.restartInFlight) return false;
    if (this.restartAttempts >= PeerConnectionManager.MAX_RESTARTS) return false;
    this.restartInFlight = true;
    this.restartAttempts += 1;
    try {
      this.pc.restartIce();
      this.remoteDescSet = false;
      this.emit('failed', 'ICE restart requested');
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.emit('connecting', 're-offer sent');
      sendOffer(offer.sdp!);
      return true;
    } catch (err) {
      this.emit('failed', `ICE restart failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.restartInFlight = false;
    }
  }

  /**
   * Rebuild the peer connection with a *different* ICE configuration (e.g. the
   * Network Inspector's host-only / relay-only policy change). iceServers and
   * iceTransportPolicy are fixed at construction, so a live change requires a
   * fresh RTCPeerConnection; the offerer recreates the DataChannel and offers
   * again, the answerer waits for it.
   */
  public async reconfigure(
    iceServers: RTCConfiguration,
    onChannelEstablished: (dc: RTCDataChannel) => void,
    sendOffer: (sdp: string) => void,
  ): Promise<void> {
    this.close();
    this.remoteDescSet = false;
    this.candidateQueue = [];
    if (this.myRole === 'offerer') {
      const dc = await this.startAsOfferer(iceServers, () => onChannelEstablished(dc));
      this.dc = dc;
      await this.createOfferAndSignal(sendOffer);
    } else {
      await this.prepareAsAnswerer(iceServers);
    }
  }

  public close(): void {
    if (!this.pc) return;
    this.pc.ondatachannel = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.dc = null;
  }

  /** Caller sets this to forward candidates to signaling. */
  public onCandidate: ((candidate: IceCandidateInit) => void) | null = null;

  private createPeer(iceServers: RTCConfiguration): void {
    if (this.pc) return;
    // Fresh connection: allow the self-heal restart budget again.
    this.restartAttempts = 0;
    this.restartInFlight = false;
    const pc = new RTCPeerConnection({ ...iceServers, iceTransportPolicy: this.icePolicy });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.onCandidate?.({ candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex });
      else this.emit(this.phase, 'end of candidates');
    };

    pc.onicecandidateerror = (ev) => {
      // A single unreachable STUN/TURN *server* (e.g. a turns: TLS handshake
      // rejection, or a dead candidate server) is expected and harmless — ICE
      // falls through to the next server. It is NOT a connection failure and
      // must NOT change the phase (which would flip the UI back to
      // "connecting"): log it against the *current* phase instead.
      if (typeof ev.errorCode === 'number') {
        this.events.onPhase(this.phase, `ice server ${ev.url ?? '?'} error ${ev.errorCode}${ev.errorText ? ` (${ev.errorText})` : ''} — fallback`, Date.now());
      }
    };

    pc.oniceconnectionstatechange = () => {
      switch (pc.iceConnectionState) {
        case 'checking':
          this.emit('connecting', 'ICE checking candidates');
          break;
        case 'connected':
        case 'completed':
          this.restartAttempts = 0;
          this.restartInFlight = false;
          this.emit('connected', `ICE ${pc.iceConnectionState}`);
          break;
        case 'disconnected':
          this.emit('disconnected', 'ICE disconnected (path degraded)');
          break;
        case 'failed':
          // The offerer (sender) actually performs the restart via
          // main.ts -> restartIce(); we only report the state change here.
          // Important: do NOT set restartInFlight in this branch — doing so
          // deadlocked restartIce() (its re-entrancy flag was already true
          // before the call) so the self-heal never actually ran.
          this.emit('failed', 'ICE failed');
          break;
        default:
          break;
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.emit('connected', 'peer connection connected');
      if (pc.connectionState === 'disconnected') this.emit('disconnected', 'peer connection disconnected');
    };

    // Wire the inbound-channel path unconditionally: only the answerer ever
    // receives one in this app, and not depending on myRole avoids ordering
    // bugs (myRole is decided outside createPeer, see startAsOfferer/
    // prepareAsAnswerer). The offerer's own pc never fires this event.
    pc.ondatachannel = (ev) => {
      const dc = ev.channel;
      dc.binaryType = 'arraybuffer';
      this.dc = dc;
      this.emit('connected', 'data channel opened');
      this.events.onDataChannel(dc);
    };
  }

  private async flushCandidates(): Promise<void> {
    if (!this.pc) return;
    for (const cand of this.candidateQueue) {
      try {
        await this.pc.addIceCandidate(cand as RTCIceCandidateInit);
      } catch (err) {
        console.warn('queued candidate rejected', err);
      }
    }
    this.candidateQueue = [];
  }

  private channelInitialized(dc: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      const onOpen = () => {
        dc.removeEventListener('open', onOpen);
        resolve();
      };
      dc.addEventListener('open', onOpen);
    });
  }

  private emit(phase: ConnectionPhase, detail?: string): void {
    this.phase = phase;
    this.events.onPhase(phase, detail, Date.now());
  }
}