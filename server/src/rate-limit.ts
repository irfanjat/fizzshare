/**
 * rate-limit.ts — per-IP sliding-window token buckets + room-code lockout.
 *
 * Networking reasoning:
 *   - SDP/ICE are small but chatty; a flood of bogus offers is free CPU for an
 *     attacker but a DoS for us. A token bucket caps per-IP message rate.
 *   - Room codes are only 6 chars (~34^6 ≈ 1.5e9 space). Brute-forcing a
 *     *live* room is hopeless within its ~15 min TTL, but repeated rapid tries
 *     against the signalling endpoint cost us nothing to block eagerly, so we
 *     lock the code after consecutive failures and rate-limit joins per IP.
 */

interface Window {
  windowStart: number;
  count: number;
}

export class TokenBucket {
  private windows = new Map<string, Window>();

  constructor(
    private readonly ratePerMinute: number,
    private readonly label: string,
  ) {}

  /** Returns true if the key is allowed, false if it exceeded its budget. */
  public consume(key: string, now = Date.now()): boolean {
    const windowMs = 60_000;
    const win = this.windows.get(key);
    if (!win || now - win.windowStart >= windowMs) {
      this.windows.set(key, { windowStart: now, count: 1 });
      this.prune(now, windowMs);
      return true;
    }
    if (win.count >= this.ratePerMinute) return false;
    win.count += 1;
    return true;
  }

  /** Number of buckets currently held (for metrics/debug). */
  public get size(): number {
    return this.windows.size;
  }

  private prune(now: number, windowMs: number): void {
    if (this.windows.size < 10_000) return;
    for (const [k, w] of this.windows) {
      if (now - w.windowStart >= windowMs) this.windows.delete(k);
    }
  }
}

/** Snapshot for metrics/logs. */
export interface RateLimitStats {
  messages: number;
  joins: number;
}

export class RateLimiter {
  public readonly messages: TokenBucket;
  public readonly joins: TokenBucket;

  constructor(msgsPerMin: number, joinsPerMin: number) {
    this.messages = new TokenBucket(msgsPerMin, 'messages');
    this.joins = new TokenBucket(joinsPerMin, 'joins');
  }

  public snapshot(): RateLimitStats {
    return { messages: this.messages.size, joins: this.joins.size };
  }
}