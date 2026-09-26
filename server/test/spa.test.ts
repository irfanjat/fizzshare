import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildServer, type ServerHandle } from '../src/index.js';
import type { Config } from '../src/config.js';

const FIXTURE = '<!doctype html><html><head><title>peershare</title></head><body>app</body></html>';

/** server.listen is async; poll until the handle is bound and accepts connections. */
async function waitReady(s: ServerHandle): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const p = s.port;
    if (p > 0) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/healthz`);
        if (r.ok) return `http://127.0.0.1:${p}`;
      } catch {
        /* not accepting yet */
      }
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('server did not become ready');
}

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peershare-spa-'));
  fs.writeFileSync(path.join(dir, 'index.html'), FIXTURE);
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');
  return dir;
}

function server(): ServerHandle {
  const cfg: Config = {
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1',
    origins: ['http://127.0.0.1'],
    publicDir: makeFixture(),
    roomTtlMs: 60_000,
    sweepIntervalMs: 30_000,
    maxPeersPerRoom: 2,
    roomCodeLength: 6,
    maxPayloadBytes: 1 << 20,
    turn: null,
    rateLimit: { messagesPerMinute: 600, joinsPerMinute: 8, joinFailLockMs: 60_000, maxJoinFails: 5 },
    logLevel: 'silent',
  };
  return buildServer(cfg);
}

test('serves index.html at the root', async (t) => {
  const s = server();
  t.after(() => s.close());
  const base = await waitReady(s);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') ?? '').includes('text/html'));
  assert.ok((await res.text()).includes('peershare'));
});

test('serves the SPA shell for /c/<CODE> deep links', async (t) => {
  const s = server();
  t.after(() => s.close());
  const base = await waitReady(s);
  const res = await fetch(`${base}/c/ABCDEF`);
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') ?? '').includes('text/html'));
  assert.ok((await res.text()).includes('peershare'));
});

test('still serves static assets, healthz and metrics', async (t) => {
  const s = server();
  t.after(() => s.close());
  const base = await waitReady(s);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  const hz = await fetch(`${base}/healthz`);
  assert.equal(hz.status, 200);
  assert.ok((hz.headers.get('content-type') ?? '').includes('json'));
  const me = await fetch(`${base}/metrics`);
  assert.equal(me.status, 200);
  assert.ok((me.headers.get('content-type') ?? '').includes('text/plain'));
});