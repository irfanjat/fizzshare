import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomRegistry, CODE_ALPHABET } from '../src/rooms.js';

function makeRegistry() {
  return new RoomRegistry({
    codeLength: 6,
    ttlMs: 60_000,
    maxPeers: 2,
    maxJoinFails: 3,
    lockMs: 5_000,
  });
}

const fakeWs = { readyState: 1 } as never;

test('create allocates a unique code from the unambiguous alphabet', () => {
  const r = makeRegistry();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { room } = r.create(`p${i}`, fakeWs);
    assert.equal(room.code.length, 6);
    assert.ok(!seen.has(room.code));
    for (const ch of room.code) assert.ok(CODE_ALPHABET.includes(ch));
    seen.add(room.code);
  }
});

test('join fills a room to exactly two peers, then rejects', () => {
  const r = makeRegistry();
  const { room } = r.create('creator', fakeWs);
  const ok = r.join(room.code, 'joiner', fakeWs);
  assert.notEqual(ok, 'ROOM_NOT_FOUND');
  const full = r.join(room.code, 'third', fakeWs);
  assert.equal(full, 'ROOM_FULL');
});

test('unknown code returns ROOM_NOT_FOUND', () => {
  const r = makeRegistry();
  assert.equal(r.join('ZZZZZZ', 'p', fakeWs), 'ROOM_NOT_FOUND');
});

test('repeated failed joins lock the code', () => {
  const r = makeRegistry();
  const { room } = r.create('creator', fakeWs);
  for (let i = 0; i < 3; i++) {
    r.registerJoinFailure(room.code);
  }
  const res = r.join(room.code, 'p', fakeWs);
  assert.equal(res, 'ROOM_LOCKED');
});

test('leaving a two-peer room keeps the room alive for the survivor', () => {
  const r = makeRegistry();
  const { room: created } = r.create('creator', fakeWs);
  r.join(created.code, 'joiner', fakeWs);
  const { room, code } = r.leave('creator');
  assert.ok(room, 'room must survive the creator leaving');
  assert.equal(code, created.code);
  assert.ok(room.peers.has('joiner'));
});

test('leaving the last peer destroys the room and frees the code', () => {
  const r = makeRegistry();
  r.create('only', fakeWs);
  const { code } = r.leave('only');
  assert.ok(code && code.length === 6);
  assert.equal(r.getRoomByCode(code), undefined, 'registry must not retain the room');
});

test('room expiry via sweep notifies caller of dropped rooms', () => {
  const r = makeRegistry();
  const { room } = r.create('a', fakeWs);
  const afterExpiry = Date.now() + 61_000;
  const expired = r.sweep(afterExpiry);
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.code, room.code);
  assert.equal(r.activeRoomCount, 0);
});

test('sweep keeps young rooms', () => {
  const r = makeRegistry();
  r.create('a', fakeWs);
  assert.equal(r.sweep().length, 0);
  assert.equal(r.activeRoomCount, 1);
});

test('getOtherPeer returns the counterpart only in a two-peer room', () => {
  const r = makeRegistry();
  const { room } = r.create('a', fakeWs);
  assert.equal(r.getOtherPeer('a'), undefined);
  r.join(room.code, 'b', fakeWs);
  const other = r.getOtherPeer('a');
  assert.ok(other);
  assert.equal(other.id, 'b');
});