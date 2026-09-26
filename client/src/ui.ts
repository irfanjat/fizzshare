/**
 * ui.ts — small DOM/formatting helpers shared by the app controller.
 */

export function $<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

export function fmtSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return '—';
  return `${fmtBytes(bps)}/s`;
}

export function fmtEta(remainingBytes: number, bps: number): string {
  if (bps <= 0 || !Number.isFinite(bps)) return '—';
  const secs = Math.round(remainingBytes / bps);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtPct(done: number, total: number): string {
  if (total <= 0) return done > 0 ? '100%' : '0%';
  return `${Math.floor((done / total) * 100)}%`;
}

/** Sliding-window speed estimator. */
export class Speedometer {
  private samples: Array<{ t: number; bytes: number }> = [];
  private lastBytes = 0;

  constructor(private readonly windowMs = 3000) {}

  /** Feed cumulative bytes; returns bytes/s derived from the window slope. */
  public push(bytes: number, now = Date.now()): number {
    if (this.lastBytes > bytes && this.samples.length) {
      // reset on discontinuity (new transfer)
      this.samples = [];
    }
    this.lastBytes = bytes;
    this.samples.push({ t: now, bytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length && this.samples[0]!.t < cutoff) this.samples.shift();
    if (this.samples.length < 2) return 0;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0.01) return 0;
    const db = last.bytes - first.bytes;
    return db / dt;
  }

  public reset(): void {
    this.samples = [];
    this.lastBytes = 0;
  }
}

export function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}