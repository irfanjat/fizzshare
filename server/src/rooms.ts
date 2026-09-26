/**
 * rooms.ts — in-memory room registry.
 *
 * Networking reasoning: a room is a rendezvous point only. It holds exactly
 * two WebSocket references and NO file metadata. Rooms are short-lived and
 * always expire, because a 6-character code is a weak secret — short lifetime
 * makes it practically unbrute-forceable.
 */

import type { WebSocket } from 'ws';

/** No I, O, 0, 1 — avoids confusing a human reading the code aloud/typing it. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface RoomPeer {
  id: string;
  ws: WebSocket;
  joinedAt: number;
  isCreator: boolean;
}

export interface Room {
  code: string;
  createdAt: number;
  expiresAt: number;
  peers: Map<string, RoomPeer>;
  /** Consecutive failed join attempts on this code (brute-force lock). */
  joinFailures: number;
  /** Room locked for joins until this epoch ms. */
  lockedUntil: number;
}

export type JoinError =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_LOCKED';

export interface JoinSuccess {
  room: Room;
  peer: RoomPeer;
}

export interface RoomRegistryOptions {
  codeLength: number;
  ttlMs: number;
  maxPeers: number;
  /** How many failed joins lock a room. */
  maxJoinFails: number;
  /** Lock duration after too many failures. */
  lockMs: number;
}

function randomCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly peerToCode = new Map<string, string>();

  constructor(private readonly opts: RoomRegistryOptions) {}

  public create(peerId: string, ws: WebSocket): { room: Room; peer: RoomPeer } {
    const now = Date.now();
    const code = this.nextAvailableCode();
    const room: Room = {
      code,
      createdAt: now,
      expiresAt: now + this.opts.ttlMs,
      peers: new Map(),
      joinFailures: 0,
      lockedUntil: 0,
    };
    const peer: RoomPeer = { id: peerId, ws, joinedAt: now, isCreator: true };
    room.peers.set(peerId, peer);
    this.rooms.set(code, room);
    this.peerToCode.set(peerId, code);
    return { room, peer };
  }

  public join(code: string, peerId: string, ws: WebSocket): JoinSuccess | JoinError {
    const room = this.rooms.get(code);
    if (!room) return 'ROOM_NOT_FOUND';
    if (room.lockedUntil > Date.now()) return 'ROOM_LOCKED';
    if (room.peers.size >= this.opts.maxPeers) return 'ROOM_FULL';
    const peer: RoomPeer = { id: peerId, ws, joinedAt: Date.now(), isCreator: false };
    room.peers.set(peerId, peer);
    this.peerToCode.set(peerId, code);
    return { room, peer };
  }

  /** Record a failed join; returns whether the code got locked. */
  public registerJoinFailure(code: string): { locked: boolean; lockedUntil: number } {
    const room = this.rooms.get(code);
    if (!room) return { locked: false, lockedUntil: 0 };
    room.joinFailures += 1;
    if (room.joinFailures >= this.opts.maxJoinFails) {
      room.lockedUntil = Date.now() + this.opts.lockMs;
      room.joinFailures = 0;
      return { locked: true, lockedUntil: room.lockedUntil };
    }
    return { locked: false, lockedUntil: 0 };
  }

  /** Remove a peer; returns the room they left (if any) and the code. */
  public leave(peerId: string): { room?: Room; code?: string } {
    const code = this.peerToCode.get(peerId);
    if (!code) return {};
    const room = this.rooms.get(code);
    this.peerToCode.delete(peerId);
    if (!room) return { code };
    room.peers.delete(peerId);
    if (room.peers.size === 0) {
      this.rooms.delete(code);
      return { room, code };
    }
    return { room, code };
  }

  public getRoomByCode(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  public getOtherPeer(peerId: string): RoomPeer | undefined {
    const code = this.peerToCode.get(peerId);
    if (!code) return undefined;
    const room = this.rooms.get(code);
    if (!room) return undefined;
    for (const [id, peer] of room.peers) {
      if (id !== peerId) return peer;
    }
    return undefined;
  }

  public getRoomOf(peerId: string): Room | undefined {
    const code = this.peerToCode.get(peerId);
    return code ? this.rooms.get(code) : undefined;
  }

  public getPeer(peerId: string): { peer?: RoomPeer; code?: string } {
    const code = this.peerToCode.get(peerId);
    if (!code) return {};
    const room = this.rooms.get(code);
    return { peer: room?.peers.get(peerId), code };
  }

  /** Drop expired/empty rooms. Returns rooms that must be notified+closed. */
  public sweep(now = Date.now()): Room[] {
    const expired: Room[] = [];
    for (const [code, room] of this.rooms) {
      if (room.expiresAt <= now || room.peers.size === 0) {
        expired.push(room);
        this.rooms.delete(code);
        for (const peer of room.peers.keys()) this.peerToCode.delete(peer);
      }
    }
    return expired;
  }

  public get activeRoomCount(): number {
    return this.rooms.size;
  }

  public get peerCount(): number {
    return this.peerToCode.size;
  }

  private nextAvailableCode(): string {
    for (let i = 0; i < 100; i++) {
      const code = randomCode(this.opts.codeLength);
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Unable to allocate a unique room code');
  }
}