/**
 * signaling.ts — routes validated messages between the two peers in a room,
 * and issues room + TURN credentials.
 *
 * Networking reasoning: the signaling server is a dumb mailbox. It relays
 * offers/answers/ICE candidates verbatim and tacks a little connection
 * metadata (peer id) onto them. It cannot and does not interpret SDP/ICE
 * content — exactly the property that keeps it agnostic to NAT topology.
 */

import { WebSocket, type RawData } from 'ws';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import type { RoomRegistry, RoomPeer } from './rooms.js';
import type { TokenBucket } from './rate-limit.js';
import { InvalidMessageError, parseClientMessage, type ClientMessage } from './validate.js';
import { buildIceServers, issueTurnCredentials } from './turn.js';

export interface Session {
  peerId: string;
  ws: WebSocket;
  ip: string;
  /** Set once create-room or join-room succeeds. */
  bound: boolean;
}

interface SignalingDeps {
  cfg: Config;
  registry: RoomRegistry;
  metrics: Metrics;
  logger: Logger;
  msgLimiter: TokenBucket;
}

export interface ServerNotice {
  kind: 'peer-left' | 'room-closed';
  room: { code: string };
}

export function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function toText(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

export class SignalingRouter {
  constructor(private readonly deps: SignalingDeps) {}

  /**
   * Handle one inbound text message.
   * Returns a notice (room/peer events the connection layer should act on) or
   * null. Throws InvalidMessageError for bad messages.
   */
  public route(session: Session, raw: RawData): ServerNotice | null {
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(toText(raw));
    } catch (err) {
      if (err instanceof InvalidMessageError) {
        this.deps.metrics.inc('peershare_messages_total', 'Signaling messages routed', { type: 'invalid' });
        sendJson(session.ws, { type: 'error', error: err.reason, message: err.message });
      }
      throw err;
    }

    // Control-plane abuse guard: consumers of a fixed budget, keyed by IP.
    if (!this.deps.msgLimiter.consume(session.ip)) {
      this.deps.metrics.inc('peershare_messages_total', 'Signaling messages routed', { type: 'rate-limited' });
      sendJson(session.ws, { type: 'error', error: 'RATE_LIMITED', message: 'Slow down' });
      throw new InvalidMessageError('rate limited', 'RATE_LIMITED');
    }

    this.deps.metrics.inc('peershare_messages_total', 'Signaling messages routed', { type: msg.type });

    switch (msg.type) {
      case 'create-room':
        this.onCreateRoom(session);
        return null;
      case 'join-room':
        return this.onJoinRoom(session, msg.code);
      case 'offer':
        this.forwardToPeer(session, { type: 'offer', sdp: msg.sdp, from: session.peerId });
        return null;
      case 'answer':
        this.forwardToPeer(session, { type: 'answer', sdp: msg.sdp, from: session.peerId });
        return null;
      case 'ice':
        this.forwardToPeer(session, { type: 'ice', candidate: msg.candidate, from: session.peerId });
        return null;
      case 'restart':
        this.forwardToPeer(session, { type: 'restart', policy: msg.policy, from: session.peerId });
        return null;
      case 'telemetry':
        this.onTelemetry(msg);
        return null;
      case 'bye':
        return this.onBye(session);
    }
  }

  private onCreateRoom(session: Session): void {
    if (session.bound) {
      throw new InvalidMessageError('already in a room', 'ALREADY_BOUND');
    }
    const { room, peer } = this.deps.registry.create(session.peerId, session.ws);
    session.bound = true;
    this.deps.metrics.inc('peershare_rooms_created_total', 'Rooms created');
    this.deps.metrics.set('peershare_rooms_active', 'Active (non-empty) rooms', this.deps.registry.activeRoomCount);
    this.deps.logger.info('room-created', { room: room.code, ttlSec: Math.round(room.expiresAt / 1000) - Math.round(Date.now() / 1000) });

    sendJson(session.ws, {
      type: 'room-created',
      code: room.code,
      peerId: peer.id,
      iceServers: this.issueIceServers(),
      expiresAt: room.expiresAt,
    });
  }

  private onJoinRoom(session: Session, code: string): ServerNotice | null {
    if (session.bound) throw new InvalidMessageError('already in a room', 'ALREADY_BOUND');

    this.deps.metrics.inc('peershare_join_attempts_total', 'Join attempts', { result: 'attempted' });

    if (!this.deps.msgLimiter.consume(`${session.ip}/join`)) {
      sendJson(session.ws, { type: 'error', error: 'JOIN_RATE_LIMITED', message: 'Too many join attempts, try again later' });
      return null;
    }

    const result = this.deps.registry.join(code, session.peerId, session.ws);
    if (typeof result === 'string') {
      this.deps.metrics.inc('peershare_join_attempts_total', 'Join attempts', { result: result.toLowerCase() });
      if (result === 'ROOM_NOT_FOUND' || result === 'ROOM_FULL') {
        const { locked } = this.deps.registry.registerJoinFailure(code);
        if (locked) this.deps.logger.warn('join-lock', { room: code });
        sendJson(session.ws, { type: 'error', error: result, message: `join failed: ${result}` });
        return null;
      }
      sendJson(session.ws, { type: 'error', error: result, message: `join failed: ${result}` });
      return null;
    }

    session.bound = true;
    this.deps.metrics.set('peershare_rooms_active', 'Active (non-empty) rooms', this.deps.registry.activeRoomCount);
    this.deps.metrics.inc('peershare_join_attempts_total', 'Join attempts', { result: 'ok' });
    this.deps.logger.info('room-joined', { room: result.room.code });

    sendJson(session.ws, {
      type: 'room-joined',
      code: result.room.code,
      peerId: result.peer.id,
      iceServers: this.issueIceServers(),
      expiresAt: result.room.expiresAt,
    });

    // Tell the creator a peer arrived.
    const creator = this.deps.registry.getOtherPeer(session.peerId);
    if (creator) sendJson(creator.ws, { type: 'peer-joined', from: session.peerId });

    return null;
  }

  private forwardToPeer(session: Session, payload: Record<string, unknown>): void {
    const other = this.deps.registry.getOtherPeer(session.peerId);
    if (!other) throw new InvalidMessageError('no peer in room yet', 'NO_PEER');
    sendJson(other.ws, payload);
  }

  private onTelemetry(msg: Extract<ClientMessage, { type: 'telemetry' }>): void {
    // Client-side getStats result; the ONLY file-agnostic signal we get about
    // whether media went direct or through TURN. Aggregated into Prometheus.
    this.deps.metrics.inc('peershare_transfers_reported_total', 'Transfer telemetry reports from clients', {
      pairType: msg.pairType,
    });
    this.deps.logger.debug('telemetry', { pairType: msg.pairType, rttMs: msg.rttMs ?? null });
  }

  private onBye(session: Session): ServerNotice | null {
    const { room, code } = this.deps.registry.leave(session.peerId);
    session.bound = false;
    if (!room) return null;
    this.deps.metrics.set('peershare_rooms_active', 'Active (non-empty) rooms', this.deps.registry.activeRoomCount);
    this.deps.logger.info('room-left', { room: code ?? undefined });

    const other = room.peers.values().next().value as RoomPeer | undefined;
    if (!other) return { kind: 'room-closed', room: { code: code ?? '' } };
    sendJson(other.ws, { type: 'peer-left', from: session.peerId });
    return { kind: 'peer-left', room: { code: code ?? '' } };
  }

  private issueIceServers(): ReturnType<typeof buildIceServers> | null {
    if (!this.deps.cfg.turn) {
      this.deps.logger.warn('turn-disabled', {});
      return null;
    }
    const creds = issueTurnCredentials(this.deps.cfg.turn);
    this.deps.metrics.inc('peershare_turn_creds_issued_total', 'TURN credential sets issued');
    return buildIceServers(this.deps.cfg.turn, creds);
  }
}