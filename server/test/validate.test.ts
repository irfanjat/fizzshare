import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClientMessage,
  InvalidMessageError,
  ROOM_CODE_REGEX,
} from '../src/validate.js';

test('accepts a valid create-room', () => {
  assert.deepEqual(parseClientMessage('{"type":"create-room"}'), { type: 'create-room' });
});

test('accepts and normalizes a join-room code (case-insensitive)', () => {
  const m = parseClientMessage('{"type":"join-room","code":"ab2c3d"}');
  assert.equal(m.type, 'join-room');
  assert.equal(m.code, 'AB2C3D');
});

test('rejects malformed room codes', () => {
  assert.ok(ROOM_CODE_REGEX.test('ABCDE2'));
  assert.ok(!ROOM_CODE_REGEX.test('I0O1LR')); // ambiguous chars excluded
  assert.ok(!ROOM_CODE_REGEX.test('ABCDE')); // too short
  assert.ok(!ROOM_CODE_REGEX.test('ABCDEFG')); // too long
  for (const bad of ['"AB"', '"123456"', '"abcdefg"', '"A BCDEF"', '"ABCDEF-"']) {
    assert.throws(() => parseClientMessage(`{"type":"join-room","code":${bad}}`), InvalidMessageError);
  }
});

test('accepts offer/answer with a real-looking SDP', () => {
  const sdp = 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' + 'a=mid:0\r\n'.repeat(50);
  const m = parseClientMessage(JSON.stringify({ type: 'offer', sdp }));
  assert.equal(m.type, 'offer');
  assert.equal(m.sdp, sdp);
});

test('rejects too-short or huge SDP', () => {
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'answer', sdp: 'short' })), InvalidMessageError);
  assert.throws(
    () => parseClientMessage(JSON.stringify({ type: 'offer', sdp: 'a'.repeat(1_000_000) })),
    InvalidMessageError,
  );
});

test('accepts a well-formed ICE candidate', () => {
  const m = parseClientMessage(
    JSON.stringify({
      type: 'ice',
      candidate: { candidate: 'candidate:1 1 udp 2130706431 192.168.0.4 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    }),
  );
  assert.equal(m.type, 'ice');
});

test('rejects a candidate without a candidate line', () => {
  assert.throws(
    () => parseClientMessage(JSON.stringify({ type: 'ice', candidate: { sdpMid: '0' } })),
    InvalidMessageError,
  );
});

test('rejects unknown types and malformed JSON', () => {
  assert.throws(() => parseClientMessage('{"type":"nuke"}'), InvalidMessageError);
  assert.throws(() => parseClientMessage('not json'), InvalidMessageError);
  assert.throws(() => parseClientMessage('42'), InvalidMessageError);
});

test('accepts only whitelisted telemetry pairTypes', () => {
  const ok = parseClientMessage(JSON.stringify({ type: 'telemetry', pairType: 'relay', rttMs: 42 }));
  assert.equal(ok.pairType, 'relay');
  assert.throws(
    () => parseClientMessage(JSON.stringify({ type: 'telemetry', pairType: 'magic' })),
    InvalidMessageError,
  );
});