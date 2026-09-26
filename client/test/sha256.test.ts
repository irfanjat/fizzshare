import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sha256, sha256Hex } from '../src/sha256.js';

function nodeSha256(data: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

test('known-answer vector: empty input', () => {
  assert.equal(sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('known-answer vector: "abc"', () => {
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('known-answer vector: 64-byte block boundary then 55-byte padding boundary', () => {
  // 64 bytes exactly
  const a = new Uint8Array(64).fill(0x61);
  assert.equal(sha256Hex(a), nodeSha256(a));
  // 55 bytes (no extra block), 56 bytes (length block), 63, 64, 65
  for (const n of [1, 55, 56, 57, 63, 64, 65, 128, 1000, 100_000]) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 7 + 3) & 0xff;
    const got = sha256Hex(buf);
    assert.equal(got, nodeSha256(buf), `failed at n=${n}`);
  }
});

test('incremental updates equal one-shot digest', () => {
  const data = new Uint8Array(10_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;

  const hasher = new Sha256();
  for (let off = 0; off < data.length; off += 777) {
    hasher.update(data.subarray(off, Math.min(off + 777, data.length)));
  }
  assert.equal(hasher.digest(), nodeSha256(data));
});

test('odd-sized incremental splits match', () => {
  const data = new Uint8Array(300);
  data.fill(9);
  const h = new Sha256().update(data.subarray(0, 1)).update(data.subarray(1, 64)).update(data.subarray(64));
  assert.equal(h.digest(), nodeSha256(data));
});

test('fuzz: multi-block random buffers across sizes', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
  for (const n of [0, 1, 31, 32, 33, 54, 55, 56, 63, 64, 65, 100, 4096, 65536]) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = rnd();
    const hasher = new Sha256();
    // random-ish chunking
    for (let off = 0; off < n; ) {
      const take = Math.min(3 + ((rnd() * n) % 61), n - off);
      hasher.update(buf.subarray(off, off + take));
      off += take;
    }
    assert.equal(hasher.digest(), nodeSha256(buf), `fuzz n=${n}`);
  }
});