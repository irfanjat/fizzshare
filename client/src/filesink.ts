/**
 * filesink.ts — where received bytes land.
 *
 * ToffeeShare-style model: we never ask for a save location up-front (no
 * File System Access picker — it would block an unattended transfer). Bytes
 * are assembled in memory and each finished file is handed to the browser's
 * built-in downloader via <a download> (exactly how ToffeeShare saves files).
 * Files are also exposed as Blobs so the receiver page can offer "download
 * again" links for the rest of the session.
 *
 * Caveat (same one ToffeeShare documents for Safari/mobile): this is NOT
 * streaming to disk, so multi-GB transfers accumulate memory in the browser
 * tab. Chrome/Edge streaming-to-disk via a StreamSaver-style service worker
 * is noted as future work; the memory fallback warns past a threshold.
 */

export type SinkMode = 'memory';

export interface FileSink {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
  mode: SinkMode;
  /** The assembled file, for the received-files list on the client. */
  blob: () => Blob;
}

export interface SinkWarn {
  (message: string): void;
}

export async function openFileSink(fileName: string, size: number, mime: string, warn: SinkWarn): Promise<FileSink> {
  const parts: BlobPart[] = [];
  let bytes = 0;
  const memoryLimit = 512 * 1024 * 1024;
  return {
    mode: 'memory',
    write: async (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > memoryLimit && parts.length % 64 === 0) {
        warn(`In-memory fallback caching ${fmtBytes(bytes)} — browser downloader grabs each finished file.`);
      }
      // Copy is required: DataChannel reuses its outgoing ArrayBuffer after
      // our handler returns on some browsers. Slicing avoids corruption.
      parts.push(chunk.slice());
      return Promise.resolve();
    },
    blob: () => new Blob(parts, { type: mime || 'application/octet-stream' }),
    close: async () => {
      const blob = new Blob(parts, { type: mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}