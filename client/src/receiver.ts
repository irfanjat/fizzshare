/**
 * receiver.ts — inbound pipeline: accept prompt, streaming sink, hash verify.
 *
 * Ordered/reliable SCTP guarantees chunk arrival order, so we never reassemble
 * out-of-order — we just append to the sink and feed the incremental hash.
 * sha256 verification compares the freshly-computed hash against the one the
 * sender put in file-start. Memory stays O(window) on the stream backend.
 */

import {
  chunkPayload,
  parseChunkHeader,
  BINARY_TYPE_FILE_CHUNK,
  type AcceptMessage,
  type CancelMessage,
  type ErrorReportMessage,
  type FileEndMessage,
  type FileStartMessage,
  type MetaMessage,
} from './protocol.js';
import { Sha256 } from './sha256.js';
import { openFileSink, type FileSink } from './filesink.js';

export interface ReceiveFileProgress {
  fileIndex: number;
  fileName: string;
  bytesDone: number;
  bytesTotal: number;
  phase: 'waiting' | 'accepting' | 'writing' | 'verifying' | 'done' | 'failed' | 'cancelled';
  verified?: boolean;
}

/** A fully-received file, kept as a Blob so the page can offer "download again". */
export interface ReceivedFile {
  name: string;
  size: number;
  blob: Blob;
}

export interface ReceiverCallbacks {
  /** Ask the user whether to accept the offered file list. */
  onOffer: (meta: MetaMessage, files: { name: string; size: number; type: string }[]) => Promise<boolean>;
  onProgress: (p: ReceiveFileProgress[]) => void;
  onComplete: (verified: boolean, files: ReadonlyArray<ReceivedFile>) => void;
  onError: (message: string) => void;
  onNegotiate: () => void;
}

interface ActiveFile {
  fileIndex: number;
  name: string;
  size: number;
  hash: Sha256;
  sink: FileSink;
  bytesWritten: number;
  sha256expected: string;
}

export class Receiver {
  private readonly dc: RTCDataChannel;
  private cancelled = false;
  private active: ActiveFile | null = null;
  private currentId: string | null = null;
  private fileCount = 0;
  private fileDone = 0;
  private readonly progress: ReceiveFileProgress[] = [];
  private verifiedAll = true;
  private readonly received: ReceivedFile[] = [];

  constructor(dc: RTCDataChannel, private readonly callbacks: ReceiverCallbacks) {
    this.dc = dc;
  }

  get transferId(): string {
    return this.currentId ?? '';
  }

  /** Dispatch one inbound message (string = control, ArrayBuffer = chunk). */
  public onMessage(ev: MessageEvent): void {
    const data = ev.data;
    if (typeof data === 'string') {
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      this.onControl(msg as MetaMessage | AcceptMessage | CancelMessage | FileStartMessage | FileEndMessage | ErrorReportMessage);
      return;
    }
    this.onBinary(new Uint8Array(data as ArrayBuffer));
  }

  private onControl(msg: MetaMessage | AcceptMessage | CancelMessage | FileStartMessage | FileEndMessage | ErrorReportMessage): void {
    if (msg.t === 'meta') {
      if (this.currentId) {
        this.callbacks.onError('sender sent a second transfer while one is active');
        return;
      }
      this.currentId = msg.id;
      this.fileCount = msg.count;
      this.fileDone = 0;
      this.progress.length = 0;
      for (const f of msg.files) {
        this.progress.push({ fileIndex: this.progress.length, fileName: f.name, bytesDone: 0, bytesTotal: f.size, phase: 'waiting' });
      }
      void this.askUser(msg);
    } else if (msg.t === 'cancel' && msg.id === this.currentId) {
      this.cancel(msg.message);
    } else if (msg.t === 'file-start' && msg.id === this.currentId) {
      void this.openFile(msg as FileStartMessage);
    } else if (msg.t === 'file-end' && msg.id === this.currentId) {
      void this.finishFile(msg as FileEndMessage);
    }
  }

  private async askUser(msg: MetaMessage): Promise<void> {
    this.callbacks.onNegotiate();
    const list = msg.files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    let accepted = false;
    try {
      accepted = await this.callbacks.onOffer(msg, list);
    } catch {
      accepted = false;
    }
    if (this.cancelled) return;
    this.dc.send(
      JSON.stringify(
        accepted
          ? ({ t: 'accept', id: msg.id } satisfies AcceptMessage)
          : ({ t: 'cancel', id: msg.id, reason: 'user', message: 'receiver declined' } satisfies CancelMessage),
      ),
    );
    if (!accepted) this.cancel('receiver declined');
  }

  private async openFile(msg: FileStartMessage): Promise<void> {
    if (this.active) {
      this.callbacks.onError(`file-start while writing "${this.active.name}"`);
      return;
    }
    const p = this.progress[msg.fileIndex];
    if (p) {
      p.phase = 'writing';
      p.bytesDone = 0;
      p.bytesTotal = msg.size;
    }
    let sink: FileSink;
    try {
      sink = await openFileSink(msg.name, msg.size, msg.type, (w) => this.callbacks.onError(w));
    } catch (err) {
      this.callbacks.onError((err as Error).message);
      this.dc.send(JSON.stringify({ t: 'cancel', id: msg.id, reason: 'io-error', message: 'save cancelled' }));
      return;
    }
    this.active = {
      fileIndex: msg.fileIndex,
      name: msg.name,
      size: msg.size,
      hash: new Sha256(),
      sink,
      bytesWritten: 0,
      sha256expected: msg.sha256,
    };
  }

  private onBinary(data: Uint8Array): void {
    if (!this.active) return;
    try {
      const header = parseChunkHeader(data);
      if (header.type !== BINARY_TYPE_FILE_CHUNK) return;
      const payload = chunkPayload(data);
      if (this.cancelled) return;
      void this.sinkWrite(payload);
      this.active.bytesWritten += payload.byteLength;
      this.active.hash.update(payload);
      const p = this.progress[this.active.fileIndex];
      if (p) p.bytesDone = this.active.bytesWritten;
      this.callbacks.onProgress(this.progress.map((x) => ({ ...x })));
    } catch (err) {
      this.callbacks.onError(`bad chunk: ${(err as Error).message}`);
    }
  }

  /** Cap concurrent sink writes so a slow disk creates natural backpressure. */
  private sinkQueue = Promise.resolve();
  private sinkWrite(payload: Uint8Array): Promise<void> {
    const active = this.active;
    if (!active) return Promise.resolve();
    this.sinkQueue = this.sinkQueue.then(() => active.sink.write(payload));
    // Trigger progress on completion so UI reflects disk-backed writes too.
    return this.sinkQueue;
  }

  private async finishFile(msg: FileEndMessage): Promise<void> {
    const active = this.active;
    if (!active) return;
    const p = this.progress[active.fileIndex];
    if (p) p.phase = 'verifying';

    await this.sinkQueue.catch(() => undefined);
    try {
      await active.sink.close();
    } catch (err) {
      this.callbacks.onError(`error finalizing "${active.name}": ${(err as Error).message}`);
    }
    const computed = active.hash.digest();
    const verified = computed === active.sha256expected;
    this.verifiedAll = this.verifiedAll && verified;
    this.received.push({ name: active.name, size: active.size, blob: active.sink.blob() });
    if (p) {
      p.verified = verified;
      p.phase = 'done';
      p.bytesDone = msg.bytes;
    }
    this.active = null;
    this.fileDone += 1;
    this.callbacks.onProgress(this.progress.map((x) => ({ ...x })));

    if (!verified) {
      this.callbacks.onError(
        `SHA-256 mismatch for "${active.name}" — expected ${active.sha256expected.slice(0, 12)}… got ${computed.slice(0, 12)}…`,
      );
    }

    if (this.fileDone >= this.fileCount) {
      this.dc.send(JSON.stringify({ t: 'done', id: this.currentId, verified: this.verifiedAll }));
      this.callbacks.onComplete(this.verifiedAll, [...this.received]);
    }
  }

  /** Everything received this session, for re-download links. */
  public getReceivedFiles(): ReadonlyArray<ReceivedFile> {
    return [...this.received];
  }

  public cancel(message?: string): void {
    this.cancelled = true;
    if (this.active) {
      const p = this.progress[this.active.fileIndex];
      if (p) p.phase = 'cancelled';
      void this.active.sink.abort();
      this.active = null;
    }
    this.callbacks.onProgress(this.progress.map((x) => ({ ...x })));
    this.callbacks.onError(message ?? 'transfer cancelled');
  }
}