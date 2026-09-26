/**
 * main.ts — app controller. Wires the landing flow, room state, signaling,
 * RTCPeerConnection lifecycle, transfer pipeline, and the event log together.
 *
 * Roles:
 *   sender  = creates room, offers, creates the DataChannel, uploads
 *   receiver = joins room, answers, receives the DataChannel
 */

import { SignalingClient, signalingUrl, type ServerMessage } from './signaling.js';
import { PeerConnectionManager, makeIceServers, type IceCandidateInit, type ConnectionPhase } from './connection.js';
import { NetworkInspector, type IcePolicy } from './inspector.js';
import { Sender, type FileProgress } from './sender.js';
import { Receiver, type ReceiveFileProgress, type ReceivedFile } from './receiver.js';
import { sampleStats, kindLabel } from './stats.js';
import { fmtBytes, fmtPct, fmtSpeed, fmtEta, Speedometer, timestamp, $ } from './ui.js';
import { renderShareQr } from './qr.js';

interface FileUiEntry {
  name: string;
  size: number;
}

class App {
  private readonly signal = new SignalingClient({ onMessage: (m) => this.onSignal(m), onOpen: () => this.log('signaling open'), onClose: () => this.log('signaling closed') });
  private manager: PeerConnectionManager | null = null;
  private sender: Sender | null = null;
  private receiver: Receiver | null = null;
  private role: 'none' | 'sender' | 'receiver' = 'none';
  private roomCode = '';
  private iceServers: RTCConfiguration = {};
  /** Identity-enabled servers; may be overridden by the inspector (host/relay). */
  private effectiveServers: RTCConfiguration = {};
  private files: File[] = [];
  private logging = true;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly speedometer = new Speedometer();
  private overallBytes = 0;
  private inspector: NetworkInspector | null = null;
  private phase: ConnectionPhase = 'idle';
  private shareLink = '';
  private wakeLock: { release: () => Promise<void> } | null = null;

  constructor() {
    this.wireEvents();
    this.checkSecureContext();
    this.handleShareRoute();
  }

  /** ToffeeShare-style share links: <origin>/c/CODE (path) or legacy #/CODE. */
  private handleShareRoute(): void {
    const pathMatch = /^\/c\/([A-Za-z0-9]{1,32})$/.exec(location.pathname);
    const hashMatch = /#\/([A-Za-z0-9]{1,32})$/.exec(location.hash);
    const code = (pathMatch?.[1] ?? hashMatch?.[1] ?? '').toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return;
    this.log(`share link opens room ${code}`);
    $('#landing').classList.add('hidden');
    ($('#room-code') as HTMLInputElement).value = code;
    $('#receive-flow').classList.remove('hidden');
    this.joinRoom();
  }

  private checkSecureContext(): void {
    if (!window.isSecureContext) {
      $('#secure-note').classList.remove('hidden');
    }
  }

  private wireEvents(): void {
    $('#btn-share').addEventListener('click', () => $('#file-input').click());
    document.querySelectorAll('.btn-main-share').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.preventDefault();
        $('#file-input').click();
      }),
    );
    document.querySelectorAll('.receive-open').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        $('#receive-flow').classList.remove('hidden');
        window.scrollTo({ top: document.getElementById('receive-flow')!.offsetTop - 80, behavior: 'smooth' });
      }),
    );
    $('#file-input').addEventListener('change', (ev) => {
      const target = ev.target as HTMLInputElement;
      this.onFilesPicked(Array.from(target.files ?? []));
      target.value = '';
    });

    const drop = $('#drop-zone');
    drop.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest?.('a, .receive-open')) return;
      $('#file-input').click();
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
      this.onFilesPicked(Array.from(e.dataTransfer?.files ?? []));
    });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('#file-input').click(); });

    $('#btn-create-room').addEventListener('click', () => this.createRoom());
    $('#btn-send').addEventListener('click', () => this.startTransfer());
    $('#btn-pause').addEventListener('click', () => this.togglePause());
    $('#btn-cancel').addEventListener('click', () => this.cancelTransfer());
    $('#btn-join').addEventListener('click', () => this.joinRoom());

    $('#btn-copy-link').addEventListener('click', () => this.copyShareLink());
    $('#btn-download-all').addEventListener('click', () => this.downloadAllReceived());
    $('#btn-inspector').addEventListener('click', () => $('#inspector-root').classList.toggle('hidden'));

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (this.sender || this.receiver)) void this.acquireWakeLock();
    });
  }

  /* ---------- share link ---------- */

  private renderShareBox(): void {
    const link = `${location.origin}/c/${this.roomCode}`;
    this.shareLink = link;
    ($('#share-link') as HTMLInputElement).value = link;
    $('#share-box').classList.remove('hidden');
    const canvas = document.getElementById('qr-canvas') as HTMLCanvasElement | null;
    if (canvas) renderShareQr(canvas, link);
  }

  private async copyShareLink(): Promise<void> {
    if (!this.shareLink) return;
    const btn = $('#btn-copy-link');
    try {
      await navigator.clipboard.writeText(this.shareLink);
    } catch {
      const input = $('#share-link') as HTMLInputElement;
      input.select();
      input.setSelectionRange(0, input.value.length);
      document.execCommand('copy');
    }
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    this.toast('Link copied to clipboard');
    setTimeout(() => {
      btn.textContent = prev;
    }, 2000);
  }

  /** Bottom toast, styled like ToffeeShare's notifications. */
  private toast(text: string): void {
    const el = $('#toast');
    el.textContent = text;
    el.classList.remove('hidden', 'show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  private renderReceivedFiles(files: ReadonlyArray<ReceivedFile>): void {
    const list = $('#received-list');
    list.innerHTML = '';
    for (const f of files) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f.blob);
      a.download = f.name;
      a.rel = 'noopener';
      a.textContent = f.name;
      a.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(a.href), 30_000));
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = fmtBytes(f.size);
      li.append(a, sz);
      list.appendChild(li);
    }
    $('#btn-download-all').classList.toggle('hidden', files.length < 2);
    $('#received-files').classList.remove('hidden');
  }

  private downloadAllReceived(): void {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('#received-list a'));
    links.forEach((a, i) => {
      setTimeout(() => {
        const anchor = document.createElement('a');
        anchor.href = a.href;
        anchor.download = a.download;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, i * 250);
    });
  }

  /* ---------- wake lock (keep transfers alive on mobile) ---------- */

  private async acquireWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    try {
      const lock = (navigator as unknown as { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      this.wakeLock = await lock.request('screen');
    } catch {
      /* denied or unsupported — transfer still runs */
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (!this.wakeLock) return;
    try {
      await this.wakeLock.release();
    } catch {
      /* already released */
    }
    this.wakeLock = null;
  }

  /* ---------- landing / room ---------- */

  private onFilesPicked(list: File[]): void {
    this.files = list;
    const holder = $('#file-picker-list');
    holder.innerHTML = '';
    const entries: FileUiEntry[] = list.map((f) => ({ name: f.name, size: f.size }));
    const table = document.createElement('table');
    table.className = 'progress';
    table.innerHTML = `<thead><tr><th>File</th><th class="num">Size</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const e of entries) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(e.name)}</td><td class="num">${fmtBytes(e.size)}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    holder.appendChild(table);
    $('#btn-create-room').classList.remove('hidden');
    $('#send-flow').classList.remove('hidden');
    $('#landing').classList.add('hidden');
    this.log(`selected ${list.length} file(s), ${fmtBytes(list.reduce((a, f) => a + f.size, 0))} total`);
  }

  private createRoom(): void {
    this.role = 'sender';
    this.signal.setRejoin({ type: 'create-room' });
    this.signal.connect();
    this.signal.sendRaw({ type: 'create-room' });
    this.log('requesting room…');
  }

  private joinRoom(): void {
    const code = ($('#room-code') as HTMLInputElement).value.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      this.log('enter a valid 6-char code');
      return;
    }
    this.role = 'receiver';
    this.roomCode = code;
    this.signal.setRejoin({ type: 'join-room', code });
    this.signal.connect();
    this.signal.sendRaw({ type: 'join-room', code });
    this.log(`joining room ${code}…`);
  }

  /* ---------- signaling ---------- */

  private onSignal(msg: ServerMessage): void {
    switch (msg.type) {
      case 'room-created':
      case 'room-joined': {
        this.roomCode = msg.code;
        this.signal.markBound();
        this.iceServers = makeIceServers(msg.iceServers);
        this.effectiveServers = this.iceServers;
        this.renderRoomBanner(msg.type === 'room-created');
        if (msg.type === 'room-created') {
          this.renderShareBox();
          $('#btn-send').classList.add('hidden');
        }
        this.manager = new PeerConnectionManager({
          onPhase: (p, d) => this.onPhase(p, d),
          onDataChannel: (dc) => this.onDataChannel(dc),
        });
        // Both roles must forward their gathered ICE candidates to the peer.
        // (Previously only the sender did — the answerer's candidates were
        // silently dropped, so cross-device transfers could never connect.)
        this.manager.onCandidate = (c) => this.sendIce(c);
        this.mountInspector();
        this.showRoom();
        if (msg.type === 'room-joined') {
          this.log('joined room — waiting for peer to connect');
          void this.manager.prepareAsAnswerer(this.effectiveServers);
        } else {
          this.log(`room created with code ${msg.code}`);
        }
        return;
      }
      case 'peer-joined':
        this.log('peer joined the room!');
        this.setConnStateLabel('peer-joined');
        if (this.role === 'sender') {
          const m = this.manager!;
          void (async () => {
            const dc = await m.startAsOfferer(this.effectiveServers, () => {
              this.onDcOpen(dc);
            });
            await m.createOfferAndSignal((sdp) => this.signal.sendRaw({ type: 'offer', sdp }));
          })();
        }
        return;
      case 'offer':
        void this.manager?.handleOffer(msg.sdp, (sdp) => this.signal.sendRaw({ type: 'answer', sdp }));
        return;
      case 'answer':
        void this.manager?.handleAnswer(msg.sdp);
        return;
      case 'ice':
        void this.manager?.handleIce(msg.candidate as IceCandidateInit);
        return;
      case 'restart':
        this.log(`peer switched candidate policy to "${msg.policy}"`);
        this.inspector?.setPolicy(msg.policy);
        void this.performRenegotiation(msg.policy);
        return;
      case 'peer-left':
        this.log('peer left the room');
        this.setConnStateLabel('closed');
        this.inspector?.stop();
        this.manager?.close();
        void this.releaseWakeLock();
        return;
      case 'room-expired':
        this.log('room expired');
        this.setConnStateLabel('closed');
        this.inspector?.stop();
        this.manager?.close();
        void this.releaseWakeLock();
        return;
      case 'error':
        this.log(`server error: ${msg.error} — ${msg.message}`);
        return;
    }
  }

  private onCandidate: ((c: IceCandidateInit) => void) | null = null;

  private sendIce(candidate: IceCandidateInit): void {
    this.signal.sendRaw({ type: 'ice', candidate });
  }

  /* ---------- data channel ---------- */

  private onDataChannel(dc: RTCDataChannel): void {
    if (this.role !== 'receiver') return;
    dc.binaryType = 'arraybuffer';
    this.attachReceiver(dc);
    this.onDcOpen(dc);
  }

  private onDcOpen(dc: RTCDataChannel): void {
    this.log('DataChannel open — SCTP session established');
    this.setConnStateLabel('connected');
    this.startSummaryTimer();

    dc.onmessage = (ev) => {
      if (this.role === 'receiver') {
        this.receiver?.onMessage(ev);
        return;
      }
      // sender: inbound control replies (accept / done / cancel)
      if (typeof ev.data !== 'string') return;
      try {
        const o = JSON.parse(ev.data);
        if (o.t === 'accept' || o.t === 'done' || o.t === 'cancel') this.sender?.onControl(o);
      } catch {
        /* ignore */
      }
    };

    dc.onclose = () => {
      this.log('DataChannel closed');
      this.setConnStateLabel('closed');
      if (this.sender) {
        this.sender.onControl({ t: 'cancel', id: this.sender.transferId, reason: 'connection-lost', message: 'peer connection lost' });
        this.sender = null;
      }
      this.stopSummaryTimer();
    };

    if (this.role === 'sender') {
      $('#btn-pause').classList.remove('hidden');
      $('#btn-cancel').classList.remove('hidden');
      if (this.files.length > 0 && !this.sender) {
        this.log('share link opened — starting transfer automatically');
        this.startTransfer();
      } else {
        $('#btn-send').classList.remove('hidden');
        ($('#btn-send') as HTMLButtonElement).disabled = false;
      }
    }
    this.renderSafety();
    this.speedometer.reset();
  }

  private renderSafety(): void {
    const pc = this.manager?.peerConnection;
    if (!pc) return;
    const get = (d: RTCSessionDescription | null | undefined): string | null => {
      const m = /a=fingerprint:([0-9A-Fa-f:]+)/.exec(d?.sdp ?? '');
      return m ? m[1]!.toLowerCase() : null;
    };
    const local = get(pc.localDescription);
    const remote = get(pc.remoteDescription);
    const el = $('#safety');
    el.classList.remove('hidden');
    $('#safety-local').textContent = local ? fingerprintCode(local) : '—';
    $('#safety-remote').textContent = remote ? fingerprintCode(remote) : '—';
  }

  /* ---------- transfer ---------- */

  private startTransfer(): void {
    if (this.sender) return;
    const m = this.manager;
    if (!m?.channel) return;
    this.speedometer.reset();
    this.overallBytes = 0;
    void this.acquireWakeLock();
    this.sender = new Sender(m, this.files, {
      onStart: () => this.log(`starting transfer of ${this.files.length} file(s)`),
      onProgress: (p) => this.renderProgress(p),
      onComplete: (verified) => {
        this.log(verified ? 'transfer complete — SHA-256 verified ✔' : 'transfer complete — SHA-256 MISMATCH ✘');
        this.sendTelemetry();
        void this.releaseWakeLock();
      },
      onError: (msg) => {
        this.log(`error: ${msg}`);
        void this.releaseWakeLock();
      },
      onCancel: (reason) => {
        this.log(`transfer cancelled: ${reason}`);
        this.sender = null;
        void this.releaseWakeLock();
      },
    });
    void this.sender.start();
    $('#btn-pause').classList.remove('hidden');
    ($('#btn-send') as HTMLButtonElement).disabled = true;
  }

  private togglePause(): void {
    if (!this.sender) return;
    if (this.sender.isPaused) {
      this.sender.resume();
      $('#btn-pause').textContent = 'Pause';
      this.log('resumed');
    } else {
      this.sender.pause();
      $('#btn-pause').textContent = 'Resume';
      this.log('paused');
    }
  }

  private cancelTransfer(): void {
    this.sender?.cancel();
  }

  /* ---------- progress rendering ---------- */

  private renderProgress(p: FileProgress[]): void {
    const area = $('#progress-area');
    area.classList.remove('hidden');

    const totalBytes = p.reduce((a, x) => a + x.bytesTotal, 0);
    const doneBytes = p.reduce((a, x) => a + x.bytesDone, 0);
    this.overallBytes = doneBytes;
    const bps = this.speedometer.push(doneBytes);
    const eta = fmtEta(totalBytes - doneBytes, bps);

    let html = `<div class="meta-line">${p.filter((x) => x.phase === 'done').length}/${p.length} files · ${fmtBytes(doneBytes)} of ${fmtBytes(totalBytes)} · @ ${fmtSpeed(bps)} · ETA ${eta}</div>`;
    html += `<div class="progress-bar"><div style="width:${fmtPct(doneBytes, totalBytes)}"></div></div>`;

    html += `<table class="progress"><thead><tr><th>File</th><th class="num">State</th><th class="num">%</th></tr></thead><tbody>`;
    for (const f of p) {
      const state = f.phase === 'hashing' ? 'hashing…' : f.phase === 'transferring' ? 'sending' : f.phase === 'done' ? 'sent ✔' : f.phase;
      html += `<tr><td>${escapeHtml(f.fileName)}</td><td class="num">${state}</td><td class="num">${fmtPct(f.bytesDone, f.bytesTotal)}</td></tr>`;
    }
    html += `</tbody></table>`;
    area.innerHTML = html;
  }

  /* ---------- receiver wiring ---------- */

  private attachReceiver(dc: RTCDataChannel): void {
    this.receiver = new Receiver(dc, {
      onOffer: async (_meta, files) => {
        void this.acquireWakeLock();
        this.log(`incoming files accepted automatically (${files.length} file(s))`);
        return true;
      },
      onProgress: (p: ReceiveFileProgress[]) => this.renderReceiverProgress(p),
      onComplete: (verified, files) => {
        this.log(verified ? 'received & verified ✔' : 'received, hash MISMATCH ✘');
        this.sendTelemetry();
        this.renderReceivedFiles(files);
        void this.releaseWakeLock();
        this.receiver = null;
      },
      onError: (msg) => this.log(`receiver: ${msg}`),
      onNegotiate: () => this.log('transfer offer received'),
    });
  }

  private renderReceiverProgress(p: ReceiveFileProgress[]): void {
    const area = $('#progress-area');
    area.classList.remove('hidden');
    const doneBytes = p.reduce((a, x) => a + x.bytesDone, 0);
    const totalBytes = p.reduce((a, x) => a + x.bytesTotal, 0);
    const bps = this.speedometer.push(doneBytes);
    let html = `<div class="meta-line">receiving ${fmtBytes(doneBytes)} of ${fmtBytes(totalBytes)} · @ ${fmtSpeed(bps)}</div>`;
    html += `<div class="progress-bar"><div style="width:${fmtPct(doneBytes, totalBytes)}"></div></div>`;
    html += `<table class="progress"><thead><tr><th>File</th><th class="num">State</th><th class="num">SHA-256</th></tr></thead><tbody>`;
    for (const f of p) {
      const state = f.phase;
      const hash = f.verified === undefined ? '—' : f.verified ? '✔' : '✘';
      html += `<tr><td>${escapeHtml(f.fileName)}</td><td class="num">${state}</td><td class="num">${hash}</td></tr>`;
    }
    html += `</tbody></table>`;
    area.innerHTML = html;
  }

  /* ---------- connection summary / telemetry ---------- */

  private startSummaryTimer(): void {
    this.stopSummaryTimer();
    this.summaryTimer = setInterval(() => void this.sampleSummary(), 2000);
  }

  private stopSummaryTimer(): void {
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.summaryTimer = null;
  }

  private async sampleSummary(): Promise<void> {
    const pc = this.manager?.peerConnection;
    if (!pc) return;
    const s = await sampleStats(pc);
    $('#conn-path').textContent = kindLabel(s.pairType);
    $('#conn-rtt').textContent = s.rttMs === null ? '—' : `${s.rttMs} ms`;
  }

  private sendTelemetry(): void {
    const pc = this.manager?.peerConnection;
    if (!pc) return;
    void sampleStats(pc).then((s) => {
      this.signal.sendRaw({
        type: 'telemetry',
        pairType: s.pairType,
        rttMs: s.rttMs ?? undefined,
        durationMs: 0,
        bytesSent: s.bytesSent,
        bytesReceived: s.bytesReceived,
      });
    });
  }

  /* ---------- status / log ---------- */

  private onPhase(p: ConnectionPhase, detail?: string): void {
    this.phase = p;
    if (detail) this.log(`${p}: ${detail}`, p);
    else this.log(`connection: ${p}`, p);
    this.setConnStateLabel(p);
    if (p === 'failed') {
      // ICE restart negotation: offerer re-offers, answerer waits for it.
      if (this.role === 'sender' && this.manager) {
        void this.manager.restartIce((sdp) => this.signal.sendRaw({ type: 'offer', sdp }));
      }
    }
  }

  /* ---------- Network Inspector ---------- */

  private mountInspector(): void {
    this.inspector?.stop();
    this.inspector = new NetworkInspector({
      getPc: () => this.manager?.peerConnection ?? null,
      getPhase: () => this.phase,
      getChannel: () => this.manager?.channel ?? null,
      onPolicy: (policy) => this.applyIcePolicy(policy),
    });
    $('#inspector-root').classList.remove('hidden');
    this.inspector.start();
  }

  private applyIcePolicy(policy: IcePolicy): void {
    const m = this.manager;
    const connected = m?.peerConnection?.remoteDescription != null;
    this.stagePolicy(policy);
    if (connected) {
      // Ask the peer to rebuild too, then both sides re-negotiate; the offerer
      // drives the fresh offer so both peers gather under the same policy.
      this.signal.sendRaw({ type: 'restart', policy });
      void this.performRenegotiation(policy);
    } else {
      this.log(`candidate policy set to "${policy}" — takes effect when the peer connects`);
    }
  }

  /** Apply the local half of a policy change (our servers / transport policy). */
  private stagePolicy(policy: IcePolicy): void {
    const m = this.manager;
    if (!m) return;
    if (policy === 'relay') {
      m.setIcePolicy('relay');
      this.effectiveServers = this.iceServers;
    } else if (policy === 'host') {
      m.setIcePolicy('all');
      this.effectiveServers = { iceServers: [] }; // no STUN/TURN → host candidates only
    } else {
      m.setIcePolicy('all');
      this.effectiveServers = this.iceServers;
    }
  }

  private async performRenegotiation(policy: IcePolicy): Promise<void> {
    const m = this.manager;
    if (!m) return;
    this.stagePolicy(policy);
    const sendOffer = (sdp: string) => this.signal.sendRaw({ type: 'offer', sdp });
    this.log(`re-negotiating with "${policy}" candidate policy`);

    // A rebuild tears down the current SCTP session: cancel any transfer first.
    this.sender?.cancel();
    this.sender = null;
    this.receiver?.cancel();
    this.receiver = null;
    $('#progress-area').classList.add('hidden');
    $('#progress-area').innerHTML = '';

    try {
      await m.reconfigure(this.effectiveServers, (dc) => this.onDcOpen(dc), sendOffer);
    } catch (err) {
      this.log(`renegotiation failed: ${(err as Error).message}`);
    }
  }

  private setConnStateLabel(state: string): void {
    $('#conn-state').textContent = state;
  }

  private log(text: string, kind = ''): void {
    const box = $('#phase-log');
    if (!this.logging) return;
    const row = document.createElement('div');
    row.className = `row ${kind}`;
    row.innerHTML = `<span class="t">${timestamp()}</span> <span class="ev">${escapeHtml(text)}</span>`;
    box.appendChild(row);
    while (box.childElementCount > 250) box.removeChild(box.firstChild!);
    box.scrollTop = box.scrollHeight;
  }

  private renderRoomBanner(isCreator: boolean): void {
    const link = `${location.origin}/c/${this.roomCode}`;
    const banner = $('#room-banner');
    banner.innerHTML = isCreator
      ? `Room code: <b>${this.roomCode}</b> — share this link: <a href="${link}" target="_blank" rel="noopener">${link}</a>`
      : `Joined room <b>${this.roomCode}</b>`;
  }

  private showRoom(): void {
    $('#room').classList.remove('hidden');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function fingerprintCode(fp: string): string {
  const hex = fp.replace(/:/g, '');
  return hex.match(/.{1,4}/g)!.join(' ');
}

new App();