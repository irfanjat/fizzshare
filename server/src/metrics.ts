/**
 * metrics.ts — minimal Prometheus text exposition, zero dependencies.
 *
 * Exposed at GET /metrics. Browser-side telemetry (selected candidate pair
 * type) is folded in here so we can graph the direct-vs-relay ratio.
 */

type MetricType = 'counter' | 'gauge';

interface Metric {
  help: string;
  type: MetricType;
  values: Map<string, number>;
}

const ESCAPE = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export class Metrics {
  private readonly metrics = new Map<string, Metric>();

  public inc(name: string, help: string, labels: Record<string, string> = {}, by = 1): void {
    const m = this.get(name, help, 'counter');
    const key = this.key(labels);
    m.values.set(key, (m.values.get(key) ?? 0) + by);
  }

  public dec(name: string, help: string, labels: Record<string, string> = {}, by = 1): void {
    const m = this.get(name, help, 'gauge');
    const key = this.key(labels);
    m.values.set(key, (m.values.get(key) ?? 0) - by);
  }

  public set(name: string, help: string, value: number, labels: Record<string, string> = {}): void {
    const m = this.get(name, help, 'gauge');
    m.values.set(this.key(labels), value);
  }

  public render(timestampMs = Date.now()): string {
    const lines: string[] = [];
    for (const [name, m] of this.metrics) {
      lines.push(`# HELP ${name} ${m.help}`);
      lines.push(`# TYPE ${name} ${m.type}`);
      for (const [key, value] of m.values) {
        lines.push(`${name}${key === '' ? '' : `{${key}}`} ${value}`);
      }
    }
    lines.push(`peershare_metrics_scrape_timestamp ${Math.floor(timestampMs / 1000)}`);
    return lines.join('\n') + '\n';
  }

  private key(labels: Record<string, string>): string {
    return Object.entries(labels)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}="${ESCAPE(v)}"`)
      .join(',');
  }

  private get(name: string, help: string, type: MetricType): Metric {
    let m = this.metrics.get(name);
    if (!m) {
      m = { help, type, values: new Map() };
      this.metrics.set(name, m);
    }
    return m;
  }

  public snapshot(): Array<{ name: string; help: string; type: MetricType; values: Record<string, number> }> {
    const out: Array<{ name: string; help: string; type: MetricType; values: Record<string, number> }> = [];
    for (const [name, m] of this.metrics) {
      const values: Record<string, number> = {};
      for (const [k, v] of m.values) values[k === '' ? '_total' : k] = v;
      out.push({ name, help: m.help, type: m.type, values });
    }
    return out;
  }
}

export const metrics = new Metrics();

/** Register fixed descriptors at startup so /metrics is always self-describing. */
export function initMetrics(): void {
  metrics.set('peershare_connections_active', 'Active WebSocket connections', 0);
  metrics.set('peershare_rooms_active', 'Active (non-empty) rooms', 0);
  metrics.inc('peershare_connections_total', 'Total WebSocket connections accepted');
  metrics.inc('peershare_rooms_created_total', 'Rooms created');
  metrics.inc('peershare_join_attempts_total', 'Join attempts', { result: 'attempted' });
  metrics.inc('peershare_messages_total', 'Signaling messages routed', { type: 'create-room' });
  metrics.inc('peershare_turn_creds_issued_total', 'TURN credential sets issued');
  metrics.inc('peershare_transfers_reported_total', 'Transfer telemetry reports from clients', { pairType: 'unknown' });
}