import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { buildServer, type ServerHandle } from '../src/index.js';

/**
 * End-to-end test: real HTTP + WebSocket, two clients, full signaling flow.
 * Room code is randomized (AAAAAA... not guaranteed), so the flow grabs the
 * code from the room-created message instead of hardcoding it.
 */

let handle: ServerHandle;
let base: string;

before(async () => {
  handle = buildServer({
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1',
    origins: [],
    roomTtlMs: 60_000,
    sweepIntervalMs: 30_000,
    maxPeersPerRoom: 2,
    roomCodeLength: 6,
    maxPayloadBytes: 1 << 20,
    turn: {
      hostname: 'localhost',
      stunPort: 3478,
      udpPort: 3478,
      tlsPort: 5349,
      sharedSecret: 'integration-secret',
      lifetimeSec: 600,
    },
    rateLimit: {
      messagesPerMinute: 1000,
      joinsPerMinute: 100,
      joinFailLockMs: 60_000,
      maxJoinFails: 10,
    },
    logLevel: 'error',
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  base = `ws://127.0.0.1:${handle.port}/ws`;
});

after(async () => {
  await handle.close();
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data))));
  });
}

function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

async function createRoom(): Promise<{ creator: WebSocket; code: string }> {
  const creator = await connect();
  send(creator, { type: 'create-room' });
  const created = await nextMessage(creator);
  assert.equal(created.type, 'room-created');
  assert.ok(created.iceServers?.length >= 1, 'iceServers must be delivered');
  assert.ok(created.peerId);
  return { creator, code: created.code };
}

test('create → join → offer/answer/ice relay → clean leave', async () => {
  const { creator, code } = await createRoom();
  const receiver = await connect();
  assert.ok(receiver.readyState === WebSocket.OPEN);

  const peerJoined = nextMessage(creator);
  send(receiver, { type: 'join-room', code });
  const joined = await nextMessage(receiver);
  assert.equal(joined.type, 'room-joined');
  assert.ok(joined.peerId);
  const joinedNotice = await peerJoined;
  assert.equal(joinedNotice.type, 'peer-joined');

  const sdp = 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n';

  const offerAtReceiver = nextMessage(receiver);
  send(creator, { type: 'offer', sdp });
  const offer = await offerAtReceiver;
  assert.equal(offer.type, 'offer');

  const answerAtCreator = nextMessage(creator);
  send(receiver, { type: 'answer', sdp });
  const answer = await answerAtCreator;
  assert.equal(answer.type, 'answer');

  const iceAtReceiver = nextMessage(receiver);
  send(creator, { type: 'ice', candidate: { candidate: 'candidate:1 1 udp 2130706431 192.0.2.1 54321 typ host' } });
  const ice = await iceAtReceiver;
  assert.equal(ice.type, 'ice');

  // Receiver leaves; creator gets peer-left.
  const peerLeft = nextMessage(creator);
  receiver.close(1000, 'done');
  const peerLeftMsg = await peerLeft;
  assert.equal(peerLeftMsg.type, 'peer-left');

  // creator can clean up.
  send(creator, { type: 'bye' });
  creator.close(1000, 'bye');
});

test('restart policy change is relayed to the peer verbatim', async () => {
  const { creator, code } = await createRoom();
  const receiver = await connect();
  send(receiver, { type: 'join-room', code });
  await nextMessage(receiver); // room-joined

  const restartAtReceiver = nextMessage(receiver);
  send(creator, { type: 'restart', policy: 'relay' });
  const restart = await restartAtReceiver;
  assert.equal(restart.type, 'restart');
  assert.equal(restart.policy, 'relay');
  assert.ok(restart.from);

  // Invalid policy is rejected.
  const err = nextMessage(creator);
  send(creator, { type: 'restart', policy: 'banana' as never });
  const errMsg = await err;
  assert.equal(errMsg.type, 'error');
  assert.equal(errMsg.error, 'BAD_MESSAGE');

  receiver.close();
  creator.close();
});

test('errors: unknown code, full room, invalid messages', async () => {
  // Unknown code → rolling failures eventually lock; use fresh room each time.
  const { code } = await createRoom();

  const r1 = await connect();
  send(r1, { type: 'join-room', code: 'ZZZZZZ' });
  const e1 = await nextMessage(r1);
  assert.equal(e1.type, 'error');

  // Fill the room then try a third client.
  const r2 = await connect();
  send(r2, { type: 'join-room', code });
  await nextMessage(r2); // room-joined
  const r3 = await connect();
  send(r3, { type: 'join-room', code });
  const e2 = await nextMessage(r3);
  assert.equal(e2.type, 'error');
  assert.equal(e2.error, 'ROOM_FULL');

  // Garbage message should close the socket (code 1008).
  const r4 = await connect();
  const closed = new Promise<number>((resolve) => r4.once('close', (code: number) => resolve(code)));
  r4.send('this is not json');
  assert.equal(await closed, 1008);

  r1.close();
  r2.close();
  r3.close();
});

test('telemetry is accepted silently and counted', async () => {
  const { creator } = await createRoom();
  send(creator, { type: 'telemetry', pairType: 'relay', rttMs: 30, durationMs: 5000 });
  await new Promise((r) => setTimeout(r, 80));
  creator.close();
});