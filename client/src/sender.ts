/**
 * sender.ts — the outbound file pipeline.
 *
 * Flow per transfer: meta → (receiver accepts) → per file: hash (streamed) →
 * file-start → 16 KiB binary chunks with backpressure → file-end → receiver
 * verifies sha256 → done.
 *
 * Backpressure: we slice each stream read into 16 KiB, and before each read we
 * wait until bufferedAmount drops below the low-water mark. The send window is
 * therefore bounded (~a few MiB) instead of growing with the file. Pause is a
 * gate inside the same loop, so resuming costs nothing.
 */

import { PeerConnectionManager } from './connection.js';
import {
  encodeChunk,
  slice16KiB,
  CHUNK_HEADER_BYTES,
  type AcceptMessage,
  type CancelMessage,
  type FileEndMessage,
  type MetaMessage,
} from './protocol.js';
import { hashFileWithProgress } from './sha256.js';

const LOW_WATER = 1 * 1024 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const ACCEPT_TIMEOUT_MS = 5 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 200;

export interface FileProgress {
  fileIndex: number;
  fileName: string;
  bytesDone: number;
  bytesTotal: number;
  hashDone: boolean;
  phase: 'hashing' | 'transferring' | 'done' | 'failed';
  sha256?: string;
}

export interface SenderCallbacks {
  onProgress: (p: FileProgress[]) => void;
  onComplete: (verified: boolean) => void;
  onError: (message: string) => void;
  onCancel: (reason: string) => void;
  onStart: () => void;
}

export class Sender {
  private readonly dc: RTCDataChannel;
  private readonly id: string;
  private cancelled = false;
  private paused = false;
  private started = false;
  private readonly progress: FileProgress[] = [];
  private acceptResolver: ((accepted: boolean) => void) | null = null;
  private readonly callbacks: SenderCallbacks;

  constructor(manager: PeerConnectionManager, files: File[], callbacks: SenderCallbacks) {
    const dc = manager.channel;
    if (!dc) throw new Error('no data channel');
    this.dc = dc;
    this.id = crypto.randomUUID();
    this.callbacks = callbacks;
    this.dc.bufferedAmountLowThreshold = LOW_WATER;

    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      this.progress.push({
        fileIndex: i,
        fileName: f.name,
        bytesDone: 0,
        bytesTotal: f.size,
        hashDone: false,
        phase: 'hashing',
      });
    }
    this.files = files;
  }

  private files: File[];

  public get transferId(): string {
    return this.id;
  }

  public get isPaused(): boolean {
    return this.paused;
  }

  public get isCancelled(): boolean {
    return this.cancelled;
  }

  public async start(): Promise<void> {
    if (this.started || this.cancelled) return;
    this.started = true;
    this.callbacks.onStart();

    const msg: MetaMessage = {
      t: 'meta',
      id: this.id,
      files: this.files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      totalBytes: this.files.reduce((a, f) => a + f.size, 0),
      count: this.files.length,
    };
    this.send(msg);

    const accepted = await this.waitAccept();
    if (!accepted || this.cancelled) return;

    for (let i = 0; i < this.files.length; i++) {
      if (this.cancelled) return;
      try {
        await this.sendFile(i);
      } catch (err) {
        if (this.cancelled) return;
        this.callbacks.onError(`Failed on "${this.files[i]?.name}": ${(err as Error).message}`);
        this.send({ t: 'cancel', id: this.id, reason: 'io-error', message: (err as Error).message } satisfies CancelMessage);
        return;
      }
    }
  }

  private async sendFile(fileIndex: number): Promise<void> {
    const file = this.files[fileIndex]!;
    const p = this.progress[fileIndex]!;
    p.phase = 'hashing';

    const sha256 = await hashFileWithProgress(file, (n) => {
      p.hashDone = true;
      p.bytesDone = n;
      this.maybeEmitProgress();
    });

    if (this.cancelled) return;
    p.hashDone = true;
    p.bytesDone = 0;
    p.sha256 = sha256;
    p.phase = 'transferring';

    const chunkCount = Math.ceil(file.size / 16_384);
    this.dc.send(
      JSON.stringify({
        t: 'file-start',
        id: this.id,
        fileIndex,
        name: file.name,
        size: file.size,
        type: file.type,
        sha256,
        chunkCount,
      }),
    );

    const reader = file.stream().getReader();
    let seq = 0;
    let bytes = 0;
    try {
      for (;;) {
        await this.waitDrain();
        if (this.paused) await this.waitResumed();
        if (this.cancelled) return;
        const { done, value } = await reader.read();
        if (done) break;
        const parts = slice16KiB(value);
        for (const part of parts) {
          this.dc.send(encodeChunk(seq, part));
          seq += 1;
          bytes += part.byteLength;
        }
        p.bytesDone = bytes;
        this.maybeEmitProgress();
      }
    } finally {
      reader.releaseLock();
    }
    this.dc.send(
      JSON.stringify({
        t: 'file-end',
        id: this.id,
        fileIndex,
        bytes,
        chunks: seq,
      } satisfies FileEndMessage),
    );
    p.phase = 'done';
    this.maybeEmitProgress();
  }

  public pause(): void {
    this.paused = true;
    this.maybeEmitProgress();
  }

  public resume(): void {
    this.paused = false;
    this.maybeEmitProgress();
  }

  public cancel(): void {
    this.cancelled = true;
    this.send({ t: 'cancel', id: this.id, reason: 'user' } satisfies CancelMessage);
    this.callbacks.onCancel('cancelled by sender');
  }

  /** Inbound control replies (accept / done / cancel) land here. */
  public onControl(msg: AcceptMessage | CancelMessage | { t: 'done'; id: string; verified: boolean }): void {
    if (msg.id !== this.id) return;
    if (msg.t === 'accept') this.acceptResolver?.((msg as AcceptMessage).t === 'accept');
    else if (msg.t === 'cancel') {
      this.acceptResolver?.(false);
      this.cancelled = true;
      this.callbacks.onCancel(msg.reason === 'user' ? 'receiver cancelled' : `cancelled: ${msg.message ?? msg.reason}`);
    } else if (msg.t === 'done') {
      this.callbacks.onComplete(msg.verified);
    }
  }

  private waitAccept(): Promise<boolean> {
    return new Promise((resolve) => {
      this.acceptResolver = resolve;
      setTimeout(() => {
        if (!this.cancelled) resolve(false);
      }, ACCEPT_TIMEOUT_MS);
    });
  }

  private waitDrain(): Promise<void> {
    if (this.dc.bufferedAmount <= LOW_WATER) return Promise.resolve();
    return new Promise((resolve) => {
      const onLow = () => {
        this.dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      this.dc.addEventListener('bufferedamountlow', onLow);
      setTimeout(onLow, 250); // safety net in case the event was missed
    });
  }

  private waitResumed(): Promise<void> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!this.paused || this.cancelled) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  private lastEmit = 0;
  private maybeEmitProgress(): void {
    const now = Date.now();
    if (now - this.lastEmit < PROGRESS_INTERVAL_MS && this.progress.every((p) => p.phase !== 'done')) return;
    this.lastEmit = now;
    this.callbacks.onProgress(this.progress.map((p) => ({ ...p })));
  }

  private send(obj: unknown): void {
    if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(obj));
  }
}

/** Number is the payload per chunk; we pair it with the header for accounting. */
export const CHUNK_PAYLOAD_BYTES = 16 * 1024;
export const CHUNK_WIRE_BYTES = CHUNK_PAYLOAD_BYTES + CHUNK_HEADER_BYTES;