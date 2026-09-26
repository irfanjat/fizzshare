/**
 * config.ts — all runtime configuration, read from the environment.
 *
 * Networking reasoning: coturn credentials must never be hardcoded in the
 * client bundle. The signaling server is the ONLY component that knows the
 * shared secret, and it hands each peer a short-lived HMAC credential. This
 * keeps the relay off-limits to anonymous users and bounds relay abuse to the
 * lifetime of a single session.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface TurnConfig {
  /** Hostname clients will reach STUN/TURN at. Must match your TLS cert for turns: */
  hostname: string;
  stunPort: number;
  udpPort: number;
  tlsPort: number;
  /** Shared secret, must equal coturn's static-auth-secret. */
  sharedSecret: string;
  /** Seconds each issued credential stays valid. */
  lifetimeSec: number;
}

export interface RateLimitConfig {
  /** Max signaling messages per IP per minute. */
  messagesPerMinute: number;
  /** Max join attempts per IP per minute (brute-force guard). */
  joinsPerMinute: number;
  /** Room is locked for this long after too many failed joins on its code. */
  joinFailLockMs: number;
  /** Failed joins on one code before it gets locked. */
  maxJoinFails: number;
}

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  origins: string[];
  /** Directory holding the built client (index.html, app.js, style.css). */
  publicDir: string;
  roomTtlMs: number;
  sweepIntervalMs: number;
  maxPeersPerRoom: number;
  roomCodeLength: number;
  maxPayloadBytes: number;
  turn: TurnConfig | null;
  rateLimit: RateLimitConfig;
  logLevel: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer for ${name}: "${raw}"`);
  return n;
}

/**
 * Resolve the built-client directory. Development runs the TypeScript source
 * (tsx) so __dirname ends at server/src; the packaged container runs dist/
 * (dist/../public). Accept an explicit override and fall back through the
 * anchor points so both layouts work without extra env wiring.
 */
function resolvePublicDir(): string {
  const override = process.env.PUBLIC_DIR;
  const candidates = [
    ...(override ? [override] : []),
    path.resolve(moduleDir, '../public'),
    path.resolve(moduleDir, '../../public'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return override ?? '';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sharedSecret = env.TURN_SHARED_SECRET ?? '';
  const turnHostname = env.TURN_HOSTNAME ?? '';

  const turn: TurnConfig | null =
    sharedSecret !== '' && turnHostname !== ''
      ? {
          hostname: turnHostname,
          stunPort: intEnv('TURN_STUN_PORT', 3478),
          udpPort: intEnv('TURN_UDP_PORT', 3478),
          tlsPort: intEnv('TURN_TLS_PORT', 5349),
          sharedSecret,
          lifetimeSec: intEnv('TURN_LIFETIME_SEC', 3600),
        }
      : null;

  const origins = (env.ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  return {
    host: env.HOST ?? '0.0.0.0',
    port: intEnv('PORT', 8080),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:8080',
    publicDir: resolvePublicDir(),
    origins,
    roomTtlMs: intEnv('ROOM_TTL_SEC', 3600) * 1000,
    sweepIntervalMs: intEnv('SWEEP_INTERVAL_SEC', 30) * 1000,
    maxPeersPerRoom: intEnv('ROOM_MAX_PEERS', 2),
    roomCodeLength: intEnv('ROOM_CODE_LENGTH', 6),
    maxPayloadBytes: intEnv('WS_MAX_PAYLOAD_BYTES', 1024 * 1024),
    turn,
    rateLimit: {
      messagesPerMinute: intEnv('MSG_RATE_PER_MIN', 600),
      joinsPerMinute: intEnv('JOIN_RATE_PER_MIN', 8),
      joinFailLockMs: intEnv('JOIN_FAIL_LOCK_MS', 60_000),
      maxJoinFails: intEnv('MAX_JOIN_FAILS', 5),
    },
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}