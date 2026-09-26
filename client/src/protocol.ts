/**
 * protocol.ts — the DataChannel application protocol shared by sender/receiver.
 *
 * Design:
 *   - Control messages are JSON ({t: '...'}).
 *   - File payloads are BINARY messages with a 6-byte header
 *     (uint16 type + uint32 seq) followed by up to 16 KiB of data.
 *   - Ordered/reliable SCTP means chunks arrive in order; seq is used for
 *     progress, sanity checks, and the integrity accounting, not reassembly.
 */

export interface MetaFile {
  name: string;
  size: number;
  type: string;
}

export type ProgressMessage = {
  t: 'progress';
  id: string;
  fileIndex: number;
  fileSeq: number;
  bytesDone: number;
  bytesTotal: number;
};

export type Message =
  | MetaMessage
  | AcceptMessage
  | RejectMessage
  | FileStartMessage
  | FileEndMessage
  | CancelMessage
  | TransferDoneMessage
  | ErrorReportMessage
  | ProgressMessage;

export interface MetaMessage {
  t: 'meta';
  id: string;
  files: MetaFile[];
  totalBytes: number;
  count: number;
}

export interface AcceptMessage {
  t: 'accept';
  id: string;
}

export interface RejectMessage {
  t: 'reject';
  id: string;
  message?: string;
}

export interface FileStartMessage {
  t: 'file-start';
  id: string;
  fileIndex: number;
  name: string;
  size: number;
  type: string;
  sha256: string;
  chunkCount: number;
}

export interface FileEndMessage {
  t: 'file-end';
  id: string;
  fileIndex: number;
  bytes: number;
  chunks: number;
}

export interface CancelMessage {
  t: 'cancel';
  id: string;
  reason: 'user' | 'connection-lost' | 'io-error' | 'hash-mismatch';
  message?: string;
}

export interface TransferDoneMessage {
  t: 'done';
  id: string;
  verified: boolean;
}

export interface ErrorReportMessage {
  t: 'error';
  id: string;
  message: string;
}

/* ---- binary chunk framing ---- */

export const BINARY_TYPE_FILE_CHUNK = 0x0003;
export const CHUNK_HEADER_BYTES = 6;

export interface ChunkHeader {
  /** Always BINARY_TYPE_FILE_CHUNK for now; field exists for future streams. */
  type: number;
  seq: number;
}

export function encodeChunk(seq: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, BINARY_TYPE_FILE_CHUNK, false);
  dv.setUint32(2, seq >>> 0, false);
  out.set(payload, CHUNK_HEADER_BYTES);
  return out;
}

export function parseChunkHeader(buf: Uint8Array): ChunkHeader {
  if (buf.byteLength < CHUNK_HEADER_BYTES) throw new Error('chunk shorter than header');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { type: dv.getUint16(0, false), seq: dv.getUint32(2, false) };
}

export function chunkPayload(buf: Uint8Array): Uint8Array {
  return buf.subarray(CHUNK_HEADER_BYTES);
}

export const DEFAULT_CHUNK_SIZE = 16 * 1024;

export const PAYLOAD_EVENT = 'payload';

/** Slice an arbitrary-sized stream read into fixed 16 KiB segments. */
export function slice16KiB(data: Uint8Array, out: Uint8Array[] = []): Uint8Array[] {
  for (let off = 0; off < data.byteLength; off += DEFAULT_CHUNK_SIZE) {
    out.push(data.subarray(off, Math.min(off + DEFAULT_CHUNK_SIZE, data.byteLength)));
  }
  return out;
}