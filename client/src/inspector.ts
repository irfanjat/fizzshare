/**
 * inspector.ts — live Network Inspector panel (Phase 4).
 *
 * Polls getStats() every second and renders the underlying WebRTC machinery so
 * so you can watch a real ICE/DTLS/SCTP session: selected candidate pair, RTT
 * trend, transport throughput, packet loss, and the full candidate set. A
 * single toggle lets you shrink the candidate pool (host-only / relay-only)
 * and watch the connection re-gather — a live demonstration of what TURN is
 * for.
 *
 * The heavy lifting (stat parsing) lives in stats.ts; this file is plumbing +
 * rendering only, which keeps it DOM-trivial and friendly to manual testing.
 */

import { collectIceReport, sampleStats, kindLabel, type CandidateInfo, type StatsSnapshot, type IceReport } from './stats.js';
import { fmtBytes, fmtSpeed } from './ui.js';

export type IcePolicy = 'auto' | 'host' | 'relay';

export interface NetworkInspectorOptions {
  getPc: () => RTCPeerConnection | null;
  getPhase: () => string;
  getChannel: () => RTCDataChannel | null;
  /** Peer requested a policy change; caller applies it and renegotiates. */
  onPolicy: (policy: IcePolicy) => void;
  pollMs?: number;
}

/** Pure rate math (unit-tested in test/inspector.test.ts). */
export function throughputBetween(prev: StatsSnapshot | null, curr: StatsSnapshot, elapsedMs: number): { sentBps: number; recvBps: number } {
  if (!prev || elapsedMs <= 0) return { sentBps: 0, recvBps: 0 };
  const dtS = elapsedMs / 1000;
  return {
    sentBps: Math.max(0, Math.round((curr.bytesSent - prev.bytesSent) / dtS)),
    recvBps: Math.max(0, Math.round((curr.bytesReceived - prev.bytesReceived) / dtS)),
  };
}

const RTT_HISTORY = 12;

export class NetworkInspector {
  private readonly root: HTMLElement;
  private policy: IcePolicy = 'auto';
  private prev: { at: number; s: StatsSnapshot } | null = null;
  private rttTrend: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPhase = 'idle';

  constructor(private readonly opts: NetworkInspectorOptions) {
    const root = document.getElementById('inspector-root');
    if (!root) throw new Error('#inspector-root missing');
    this.root = root;
    this.root.innerHTML = this.skeleton();
    this.wirePolicy();
  }

  public get currentPolicy(): IcePolicy {
    return this.policy;
  }

  /** Sync the panel with a policy the remote peer initiated. */
  public setPolicy(policy: IcePolicy): void {
    this.policy = policy;
    this.renderPolicy();
  }

  public start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 1000);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public reset(): void {
    this.prev = null;
    this.rttTrend = [];
    this.policy = 'auto';
    this.renderPolicy();
  }

  private async tick(): Promise<void> {
    const pc = this.opts.getPc();
    const lastPhase = this.opts.getPhase();
    if (lastPhase !== this.lastPhase) {
      this.lastPhase = lastPhase;
      $id('insp-phase').textContent = lastPhase;
      $id('insp-phase').className = `pill phase-${lastPhase}`;
    }
    const dc = this.opts.getChannel();
    $id('insp-ice').textContent = pc?.iceConnectionState ?? '—';
    $id('insp-conn').textContent = pc?.connectionState ?? '—';
    $id('insp-dtls').textContent = '—';
    $id('insp-dc').textContent = dc?.readyState ?? '—';
    $id('insp-buffered').textContent = dc ? fmtBytes(dc.bufferedAmount) : '—';

    if (!pc) {
      $id('insp-local').textContent = '—';
      $id('insp-remote').textContent = '—';
      $id('insp-rtt').textContent = '—';
      $id('insp-trend').textContent = '';
      $id('insp-up').textContent = '0 B/s';
      $id('insp-down').textContent = '0 B/s';
      $id('insp-sent').textContent = '0 B';
      $id('insp-recv').textContent = '0 B';
      $id('insp-loss').textContent = '—';
      $id('insp-retx').textContent = '—';
      this.renderCandidates({ dtlsState: null, nominated: null, localCandidates: [], remoteCandidates: [] });
      return;
    }

    const [stats, report] = await Promise.all([sampleStats(pc), collectIceReport(pc)]);
    const now = Date.now();
    const rates = throughputBetween(this.prev?.s ?? null, stats, now - (this.prev?.at ?? now));
    this.prev = { at: now, s: stats };

    if (typeof stats.rttMs === 'number') {
      this.rttTrend.push(stats.rttMs);
      if (this.rttTrend.length > RTT_HISTORY) this.rttTrend.shift();
    }

    $id('insp-dtls').textContent = report.dtlsState ?? '—';
    const nom = report.nominated;
    $id('insp-local').textContent = nom?.local ? candLabel(nom.local) : '—';
    $id('insp-remote').textContent = nom?.remote ? candLabel(nom.remote) : '—';
    $id('insp-rtt').textContent = stats.rttMs === null ? '—' : `${stats.rttMs.toFixed(1)} ms`;
    $id('insp-trend').textContent = this.rttTrend.length ? `↘ ${this.rttTrend.map((v) => v.toFixed(1)).join(' ⟶ ')} ms` : '';
    $id('insp-up').textContent = `${fmtSpeed(rates.sentBps)}`;
    $id('insp-down').textContent = `${fmtSpeed(rates.recvBps)}`;
    $id('insp-sent').textContent = fmtBytes(stats.bytesSent);
    $id('insp-recv').textContent = fmtBytes(stats.bytesReceived);
    $id('insp-loss').textContent = `${stats.packetsLost} / ${stats.packetsSent}`;
    $id('insp-retx').textContent = String(stats.retransmissions);
    this.renderCandidates(report);
  }

  private renderCandidates(report: IceReport): void {
    const local = report.localCandidates;
    const remote = report.remoteCandidates;
    const nomLocal = report.nominated?.local;
    const nomRemote = report.nominated?.remote;
    $id('insp-cands-local').innerHTML = candTable(local, nomLocal?.id);
    $id('insp-cands-remote').innerHTML = candTable(remote, nomRemote?.id);
  }

  private wirePolicy(): void {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-policy]')) {
      b.addEventListener('click', () => {
        this.policy = b.dataset.policy as IcePolicy;
        this.renderPolicy();
        this.opts.onPolicy(this.policy);
      });
    }
  }

  private renderPolicy(): void {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-policy]')) {
      b.classList.toggle('active', b.dataset.policy === this.policy);
    }
  }

  private skeleton(): string {
    return `
      <details id="inspector" open>
        <summary id="inspector-toggle">Network Inspector <span id="insp-phase" class="pill phase-idle">idle</span></summary>
        <div class="insp-body">
          <div class="insp-cols">
            <dl class="insp-metrics">
              <div><dt>ICE state</dt><dd id="insp-ice">—</dd></div>
              <div><dt>DTLS</dt><dd id="insp-dtls">—</dd></div>
              <div><dt>Peer conn</dt><dd id="insp-conn">—</dd></div>
              <div><dt>DataChannel</dt><dd id="insp-dc">—</dd></div>
              <div><dt>Buffered</dt><dd id="insp-buffered">—</dd></div>
              <div><dt>Selected path</dt><dd id="insp-local">—</dd></div>
              <div><dt>→ peer</dt><dd id="insp-remote">—</dd></div>
              <div><dt>RTT</dt><dd id="insp-rtt">—</dd></div>
              <div><dt>RTT trend</dt><dd id="insp-trend">—</dd></div>
              <div><dt>Upload</dt><dd id="insp-up">0 B/s</dd></div>
              <div><dt>Download</dt><dd id="insp-down">0 B/s</dd></div>
              <div><dt>Sent</dt><dd id="insp-sent">0 B</dd></div>
              <div><dt>Received</dt><dd id="insp-recv">0 B</dd></div>
              <div><dt>Lost pkts</dt><dd id="insp-loss">—</dd></div>
              <div><dt>SCTP retx</dt><dd id="insp-retx">—</dd></div>
            </dl>
            <div class="insp-policy">
              <p class="hint">Candidate policy (re-negotiates if already connected — proves what TURN is for):</p>
              <div class="seg">
                <button data-policy="auto" type="button">Auto</button>
                <button data-policy="host" type="button">Host only</button>
                <button data-policy="relay" type="button">Relay only</button>
              </div>
            </div>
          </div>
          <div class="insp-cands">
            <div>
              <h3>Local candidates</h3>
              <div id="insp-cands-local" class="cand-table"></div>
            </div>
            <div>
              <h3>Remote candidates</h3>
              <div id="insp-cands-remote" class="cand-table"></div>
            </div>
          </div>
        </div>
      </details>
    `;
  }
}

function $id(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function candLabel(c: CandidateInfo): string {
  return `${kindLabel(c.kind)} ${c.protocol} ${c.address}:${c.port}`;
}

function candTable(list: CandidateInfo[], nominatedId?: string): string {
  if (list.length === 0) return '<span class="hint">—</span>';
  const rows = list
    .map((c) => {
      const star = nominatedId === c.id ? ' ★' : '';
      return `<tr title="${escapeAttr(c.id)}"><td>${escapeHtml(c.kind)}${star}</td><td>${escapeHtml(c.protocol)}</td><td>${escapeHtml(c.address)}:${c.port}</td></tr>`;
    })
    .join('');
  return `<table class="insp-nav"><thead><tr><th>Type</th><th>Proto</th><th>Address</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}