import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeChunk,
  parseChunkHeader,
  chunkPayload,
  slice16KiB,
  CHUNK_HEADER_BYTES,
  BINARY_TYPE_FILE_CHUNK,
} from '../src/protocol.js';

test('binary chunk framing round-trips header + payload', () => {
  const payload = new Uint8Array(16 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

  const wire = encodeChunk(0x00abcdef, payload);
  assert.equal(wire.byteLength, CHUNK_HEADER_BYTES + 16 * 1024);

  const header = parseChunkHeader(wire);
  assert.equal(header.type, BINARY_TYPE_FILE_CHUNK);
  assert.equal(header.seq, 0x00abcdef);

  const back = chunkPayload(wire);
  assert.equal(back.byteLength, 16 * 1024);
  for (let i = 0; i < back.length; i++) assert.equal(back[i], i & 0xff);
});

test('seq wraps cleanly through uint32', () => {
  const wire = encodeChunk(0xffffffff, new Uint8Array(8));
  assert.equal(parseChunkHeader(wire).seq, 0xffffffff);
});

test('slice16KiB splits an arbitrary buffer into 16 KiB segments', () => {
  const big = new Uint8Array(16 * 1024 * 3 + 77);
  const parts = slice16KiB(big);
  assert.equal(parts.length, 4);
  assert.equal(parts[0]!.byteLength, 16 * 1024);
  assert.equal(parts[1]!.byteLength, 16 * 1024);
  assert.equal(parts[2]!.byteLength, 16 * 1024);
  assert.equal(parts[3]!.byteLength, 77);
  const total = parts.reduce((a, p) => a + p.byteLength, 0);
  assert.equal(total, big.byteLength);
});

test('slice16KiB on empty stays empty', () => {
  assert.equal(slice16KiB(new Uint8Array(0)).length, 0);
});

test('parseChunkHeader rejects truncated buffers', () => {
  assert.throws(() => parseChunkHeader(new Uint8Array(3)));
});