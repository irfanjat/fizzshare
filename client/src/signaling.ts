/**
 * signaling.ts — browser WebSocket client for the control plane.
 *
 * Responsibilities: connect (with auto-reconnect + backoff), send typed
 * messages, dispatch inbound messages. No file data ever rides this channel.
 */

export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ServerMessage =
  | { type: 'room-created'; code: string; peerId: string; iceServers: IceServerLike[] | null; expiresAt: number }
  | { type: 'room-joined'; code: string; peerId: string; iceServers: IceServerLike[] | null; expiresAt: number }
  | { type: 'peer-joined'; from: string }
  | { type: 'peer-left'; from: string }
  | { type: 'room-expired' }
  | { type: 'offer'; sdp: string; from: string }
  | { type: 'answer'; sdp: string; from: string }
  | { type: 'ice'; candidate: RTCIceCandidateInit; from: string }
  | { type: 'restart'; policy: 'auto' | 'host' | 'relay'; from: string }
  | { type: 'error'; error: string; message: string };

export interface SignalingCallbacks {
  onMessage: (msg: ServerMessage) => void;
  onOpen: () => void;
  onClose: (detail: { wasClean: boolean; code: number }) => void;
}

export function signalingUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 500;
  private rejoin: { type: 'create-room' } | { type: 'join-room'; code: string } | null = null;

  constructor(private readonly callbacks: SignalingCallbacks) {}

  public connect(url = signalingUrl()): void {
    this.closed = false;
    this.open(url);
  }

  public sendRaw(obj: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  /** Remember what to replay on reconnect so a server restart self-heals. */
  public setRejoin(msg: { type: 'create-room' } | { type: 'join-room'; code: string }): void {
    this.rejoin = msg;
  }

  public close(): void {
    this.closed = true;
    this.rejoin = null;
    this.ws?.close();
    this.ws = null;
  }

  private open(url: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.callbacks.onOpen();
      if (this.rejoin) this.sendRaw(this.rejoin);
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.callbacks.onMessage(msg);
    };

    ws.onclose = (ev) => {
      this.callbacks.onClose({ wasClean: ev.wasClean, code: ev.code });
      // Reconnect while the room is still relevant and we weren't told to stop.
      if (!this.closed && (this.rejoin || !this.wasOnceBound)) this.scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose will always follow */
    };
  }

  private wasOnceBound = false;
  public markBound(): void {
    this.wasOnceBound = true;
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (this.closed) return;
      if (this.ws) this.open(signalingUrl());
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }
}