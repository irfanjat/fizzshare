/**
 * turn.ts — time-limited TURN credentials (TURN REST API, RFC draft-uberti).
 *
 * Scheme (the convention coturn understands with use-auth-secret + static-auth-secret):
 *   username   = "<unix-expiry>:<opaque-id>"
 *   credential = base64( HMAC-SHA1( sharedSecret, username ) )
 *
 * coturn validates that:
 *   1. HMAC(secret, username) matches the credential, AND
 *   2. the expiry timestamp embedded in the username is still in the future.
 *
 * Networking reasoning:
 *   - The browser receives fresh creds at room creation, so the JS bundle
 *     contains no shared secret and no long-lived static credential.
 *   - Expiry is driven by a server clock, so relay credentials can't outlive
 *     the room and can't be replayed after the session ends.
 */

import { createHmac, randomBytes } from 'node:crypto';
import type { TurnConfig } from './config.js';

export interface TurnCredentials {
  username: string;
  credential: string;
  lifetimeSec: number;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function issueTurnCredentials(config: TurnConfig): TurnCredentials {
  const expires = Math.floor(Date.now() / 1000) + config.lifetimeSec;
  const username = `${expires}:${randomBytes(8).toString('hex')}`;
  const credential = createHmac('sha1', config.sharedSecret)
    .update(username)
    .digest('base64');
  return { username, credential, lifetimeSec: config.lifetimeSec };
}

/**
 * Build the RTCConfiguration.iceServers payload handed to the client.
 * STUN server is listed unauthenticated; TURN server only if creds exist.
 */
export function buildIceServers(config: TurnConfig, creds: TurnCredentials): IceServer[] {
  const stunUrl = `stun:${config.hostname}:${config.stunPort}`;
  const turnUdp = `turn:${config.hostname}:${config.udpPort}?transport=udp`;
  const turnTcp = `turns:${config.hostname}:${config.tlsPort}?transport=tcp`;
  return [
    { urls: stunUrl },
    {
      urls: [turnUdp, turnTcp],
      username: creds.username,
      credential: creds.credential,
    },
  ];
}