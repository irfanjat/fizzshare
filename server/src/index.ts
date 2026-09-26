/**
 * index.ts — entry point. HTTP server (health/metrics/static) + signaling WS.
 *
 * Production topology (Phase 5/6): Caddy terminates TLS and reverse-proxies
 * /healthz, /metrics and the WebSocket upgrade to this process. This app
 * itself only speaks plain HTTP/WS on an internal port; all TLS is terminal.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { Metrics, initMetrics, metrics } from './metrics.js';
import { RoomRegistry } from './rooms.js';
import { RateLimiter } from './rate-limit.js';
import { SignalingRouter } from './signaling.js';
import { SignalingTransport } from './ws-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerHandle {
  close: () => Promise<void>;
  port: number;
  /** Debug hook used by tests: live room codes in the registry. */
  debugRoomCodes: () => string[];
}

export function buildServer(config = loadConfig()): ServerHandle {
  const logger: Logger = createLogger(config.logLevel as never);
  initMetrics();

  const registry = new RoomRegistry({
    codeLength: config.roomCodeLength,
    ttlMs: config.roomTtlMs,
    maxPeers: config.maxPeersPerRoom,
    maxJoinFails: config.rateLimit.maxJoinFails,
    lockMs: config.rateLimit.joinFailLockMs,
  });

  const rateLimiter = new RateLimiter(
    config.rateLimit.messagesPerMinute,
    config.rateLimit.joinsPerMinute,
  );

  const router = new SignalingRouter({
    cfg: config,
    registry,
    metrics,
    logger,
    msgLimiter: rateLimiter.messages,
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      activeConnections: registry.peerCount,
      activeRooms: registry.activeRoomCount,
    });
  });

  app.get('/metrics', (_req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.render());
  });

  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  // Dev convenience: serve the built client if it exists (Phase 3 fills this).
  const staticDir = config.publicDir;
  app.get('/', (_req, res) => {
    const indexFile = path.join(staticDir, 'index.html');
    if (fs.existsSync(indexFile)) res.sendFile(indexFile);
    else res.redirect(config.publicUrl);
  });
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: 'index.html', fallthrough: true }));
  }

  // ToffeeShare-style deep links: /c/<CODE> (and any other extensionless GET)
  // serve the client shell so the SPA can read the code from the URL.
  const sendIndex = (_req: express.Request, res: express.Response): void => {
    if (config.publicDir) res.sendFile(path.join(config.publicDir, 'index.html'));
    else res.status(404).type('text/plain').send('not found');
  };
  app.get(/^\/c\/[a-zA-Z0-9-]{1,32}$/, sendIndex);
  app.get(/^\/[^.]*$/, (req, res, next) => {
    if (req.path.startsWith('/ws')) return next();
    sendIndex(req, res);
  });

  const server = http.createServer(app);
  const transport = new SignalingTransport(server, {
    cfg: config,
    registry,
    metrics,
    logger,
    router,
    rateLimiter,
  });

  // Room expiry sweeper.
  const sweeper = setInterval(() => {
    const expired = registry.sweep();
    for (const room of expired) {
      logger.info('room-expired', { room: room.code });
      for (const peer of room.peers.values()) {
        sendIfOpen(peer.ws, { type: 'room-expired' });
        peer.ws.close(4001, 'room-expired');
      }
    }
    metrics.set('peershare_rooms_active', 'Active (non-empty) rooms', registry.activeRoomCount);
  }, config.sweepIntervalMs);
  sweeper.unref();

  let boundPort = config.port;
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    boundPort = typeof addr === 'object' && addr ? addr.port : config.port;
    logger.info('server-started', {
      host: config.host,
      port: boundPort,
      turn: config.turn ? `host=${config.turn.hostname}` : 'disabled',
    });
  });

  let closed = false;
  return {
    get port(): number {
      return boundPort;
    },
    // Debug hook (used by tests/dev only).
    debugRoomCodes: (): string[] => Array.from((registry as unknown as { rooms: Map<string, unknown> }).rooms.keys()),
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      transport.close();
      server.close();
      await new Promise((resolve) => server.closeAllConnections?.() ?? resolve(null));
      logger.info('server-stopped', {});
    },
  };
}

function sendIfOpen(ws: { readyState: number; send: (data: string) => void }, obj: unknown): void {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

// Start only when run directly (not imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = buildServer();
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}