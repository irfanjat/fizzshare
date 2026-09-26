import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { issueTurnCredentials, buildIceServers } from '../src/turn.js';
import type { TurnConfig } from '../src/config.js';

const cfg: TurnConfig = {
  hostname: 'turn.example.com',
  stunPort: 3478,
  udpPort: 3478,
  tlsPort: 5349,
  sharedSecret: 'test-secret',
  lifetimeSec: 600,
};

function hmac(secret: string, username: string): string {
  return createHmac('sha1', secret).update(username).digest('base64');
}

test('issueTurnCredentials embeds an expiry and HMACs the whole username', () => {
  const before = Math.floor(Date.now() / 1000) + 599;
  const cred = issueTurnCredentials(cfg);
  const [expiry, opaque] = cred.username.split(':');
  assert.ok(expiry && opaque, 'username must be "<expiry>:<opaque>"');
  assert.equal(Number(expiry), Math.floor(Date.now() / 1000) + 600);
  assert.ok(Number(expiry) >= before);
  assert.ok(
    Number(expiry) <= Math.floor(Date.now() / 1000) + 600,
    'expiry must be exactly lifetime ahead',
  );
  assert.equal(cred.credential, hmac(cfg.sharedSecret, cred.username));
});

test('credential is useless with the wrong secret', () => {
  const cred = issueTurnCredentials(cfg);
  assert.notEqual(cred.credential, hmac('wrong-secret', cred.username));
});

test('buildIceServers exposes STUN and time-limited TURN, order STUN-first', () => {
  const servers = buildIceServers(cfg, issueTurnCredentials(cfg));
  assert.equal(servers.length, 2);
  assert.equal(servers[0]?.urls, 'stun:turn.example.com:3478');
  assert.ok(Array.isArray(servers[1]?.urls));
  const urls = servers[1]?.urls as string[];
  assert.ok(urls.includes('turn:turn.example.com:3478?transport=udp'));
  assert.ok(urls.includes('turns:turn.example.com:5349?transport=tcp'));
  assert.ok(typeof servers[1]?.username === 'string');
  assert.ok(typeof servers[1]?.credential === 'string');
});