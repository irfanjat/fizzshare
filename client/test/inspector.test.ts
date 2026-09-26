import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throughputBetween, type NetworkInspectorOptions } from '../src/inspector.js';
import { emptyStats, type StatsSnapshot } from '../src/stats.js';

function statsAt(sent: number, recv: number): StatsSnapshot {
  const s = emptyStats();
  s.bytesSent = sent;
  s.bytesReceived = recv;
  return s;
}

test('inspector: zero rate when there is no previous sample', () => {
  const { sentBps, recvBps } = throughputBetween(null, statsAt(1000, 500), 1000);
  assert.equal(sentBps, 0);
  assert.equal(recvBps, 0);
});

test('inspector: rate = delta bytes over elapsed seconds', () => {
  const { sentBps, recvBps } = throughputBetween(statsAt(1000, 500), statsAt(5000, 1500), 2000);
  assert.equal(sentBps, 2000); // 4000 bytes / 2 s
  assert.equal(recvBps, 500); // 1000 bytes / 2 s
});

test('inspector: counters can go backwards between samples (restart) and clamp to zero', () => {
  const { sentBps } = throughputBetween(statsAt(5000, 0), statsAt(1000, 0), 1000);
  assert.equal(sentBps, 0);
});

test('inspector: non-positive elapsed guards against division by zero', () => {
  const { sentBps, recvBps } = throughputBetween(statsAt(0, 0), statsAt(1000, 500), 0);
  assert.equal(sentBps, 0);
  assert.equal(recvBps, 0);
});

test('inspector: options type is usable (compile-only smoke)', () => {
  const opts: NetworkInspectorOptions = {
    getPc: () => null,
    getPhase: () => 'idle',
    getChannel: () => null,
    onPolicy: () => undefined,
  };
  assert.ok('getPc' in opts);
});