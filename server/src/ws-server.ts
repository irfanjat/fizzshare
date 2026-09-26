/**
 * ws-server.ts — WebSocket transport layer: origin checks, upgrade handling,
 * per-connection lifecycle, heartbeat, and session cleanup.
 *
 * Networking reasoning:
 *   - Origin checks stop cross-site WebSocket hijacking (an attacker site can
 *     otherwise ask the browser to open a WS to our origin and piggyback).
 *   - Heartbeat (ping/pong) is needed because many NATs drop idle UDP/TCP
 *     mappings; a dead client that no longer pongs is terminated so its room
 *     slot frees up for the peer.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import type { RoomRegistry } from './rooms.js';
import type { RateLimiter } from './rate-limit.js';
import { SignalingRouter, sendJson, type Session, type ServerNotice } from './signaling.js';
import { InvalidMessageError } from './validate.js';

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;

interface ConnectionOptions {
  cfg: Config;
  registry: RoomRegistry;
  metrics: Metrics;
  logger: Logger;
  router: SignalingRouter;
  rateLimiter: RateLimiter;
}

/** Best-effort client IP: first X-Forwarded-For hop (Caddy appends it). */
function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!origin) return false;
  return allowed.includes(origin);
}

export class SignalingTransport {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<WebSocket, Session>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(server: http.Server, private readonly opts: ConnectionOptions) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: opts.cfg.maxPayloadBytes });

    // handleUpgrade lets us run checks (path, origin, rate limit) BEFORE any frame.
    server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, opts.cfg.origins)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const ip = clientIp(req);
      if (!opts.rateLimiter.messages.consume(`${ip}/conn`)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, req));
    });

    this.heartbeat = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.heartbeat.unref();
  }

  private attach(ws: WebSocket, req: http.IncomingMessage): void {
    const session: Session = {
      peerId: randomUUID(),
      ws,
      ip: clientIp(req),
      bound: false,
    };
    this.sessions.set(ws, session);
    this.opts.metrics.set('peershare_connections_active', 'Active WebSocket connections', this.sessions.size);
    this.opts.metrics.inc('peershare_connections_total', 'Total WebSocket connections accepted');
    this.opts.logger.debug('ws-connected', { ip: session.ip });

    ws.on('message', (data) => this.onMessage(session, data));
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
    ws.on('close', () => this.onClose(session, 'remote'));
    ws.on('error', (err) => {
      this.opts.logger.warn('ws-error', { message: err.message, ip: session.ip });
    });
  }

  private onMessage(session: Session, data: RawData): void {
    if (session.ws.readyState !== WebSocket.OPEN) return;
    let notice: ServerNotice | null = null;
    try {
      notice = this.opts.router.route(session, data);
    } catch (err) {
      if (err instanceof InvalidMessageError) {
        // Validation/rate-limit errors already sent a reply; be strict and
        // drop the connection so bad actors can't spray the control plane.
        session.ws.close(1008, 'invalid-message');
      } else {
        this.opts.logger.error('ws-message-unhandled', { message: (err as Error).message });
        session.ws.close(1011, 'internal-error');
      }
      return;
    }
    if (notice?.kind === 'room-closed') {
      // The only remaining peer has left the room; close the last socket too.
      session.ws.close(1000, 'room-closed');
    }
  }

  private onClose(session: Session, reason: string): void {
    this.sessions.delete(session.ws);
    this.opts.metrics.set('peershare_connections_active', 'Active WebSocket connections', this.sessions.size);
    if (session.bound) {
      const { room, code } = this.opts.registry.leave(session.peerId);
      this.opts.metrics.set('peershare_rooms_active', 'Active (non-empty) rooms', this.opts.registry.activeRoomCount);
      if (room && code) {
        const other = room.peers.values().next().value;
        if (other) sendJson(other.ws, { type: 'peer-left', from: session.peerId });
      }
      this.opts.logger.info('ws-closed', { reason });
    }
  }

  private pingAll(): void {
    for (const [ws, session] of this.sessions) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        this.opts.logger.info('ws-heartbeat-timeout', { ip: session.ip });
        w.terminate();
        this.onClose(session, 'heartbeat-timeout');
        continue;
      }
      w.isAlive = false;
      try {
        w.ping();
      } catch {
        /* ignore */
      }
    }
  }

  public close(): void {
    clearInterval(this.heartbeat);
    for (const ws of this.sessions.keys()) ws.terminate();
    this.sessions.clear();
    this.wss.close();
  }
}