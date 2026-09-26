/**
 * stats.ts — getStats() sampling into a plain snapshot.
 *
 * This is the primitive the Network Inspector (Phase 4) polls every 500 ms;
 * here it also backs the transfer progress math and the end-of-transfer
 * telemetry report. Browsers disagree on stat shapes, so we read everything
 * defensively (Chrome nests candidates by id; Firefox embeds them in pairs).
 */

export type PairKind = 'host' | 'srflx' | 'relay' | 'unknown';

export interface StatsSnapshot {
  pairType: PairKind;
  local: { ip: string; port: number };
  remote: { ip: string; port: number };
  rttMs: number | null;
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsLost: number;
  /** SCTP retransmissions (data channel path), if the browser exposes them. */
  retransmissions: number;
  dtlsVersion: string | null;
}

interface StatLike {
  id: string;
  type: string;
  state?: string;
  selected?: boolean;
  currentRoundTripTime?: number;
  bytesSent?: number;
  bytesReceived?: number;
  packetsSent?: number;
  packetsLost?: number;
  retransmittedPacketsSent?: number;
  dtlsVersion?: string;
  dtlsState?: string;
  nominated?: boolean;
  protocol?: string;
  candidateType?: string;
  ip?: string;
  address?: string;
  port?: number;
  localCandidateId?: string;
  remoteCandidateId?: string;
  localCandidate?: StatLike;
  remoteCandidate?: StatLike;
  candidate?: string;
}

function candidateLocation(cand: StatLike | undefined): { ip: string; port: number; kind: PairKind } {
  if (!cand) return { ip: '-', port: 0, kind: 'unknown' };
  const ip = cand.ip ?? cand.address ?? '-';
  const port = cand.port ?? 0;
  const raw = cand.candidateType ?? cand.candidate?.split(' ')[7] ?? '';
  const kind: PairKind =
    raw === 'host' ? 'host' : raw === 'srflx' || raw === 'serverreflexive' ? 'srflx' : raw === 'relay' ? 'relay' : 'unknown';
  return { ip, port, kind };
}

export function emptyStats(): StatsSnapshot {
  return {
    pairType: 'unknown',
    local: { ip: '-', port: 0 },
    remote: { ip: '-', port: 0 },
    rttMs: null,
    bytesSent: 0,
    bytesReceived: 0,
    packetsSent: 0,
    packetsLost: 0,
    retransmissions: 0,
    dtlsVersion: null,
  };
}

export async function sampleStats(pc: RTCPeerConnection): Promise<StatsSnapshot> {
  const out = emptyStats();
  try {
    const report = await pc.getStats();
    const map = new Map<string, StatLike>();

    report.forEach((raw) => {
      map.set(raw.id, raw as unknown as StatLike);
    });

    let pair: StatLike | undefined;
    for (const stat of map.values()) {
      if (stat.type === 'candidate-pair') {
        if (stat.state === 'succeeded' && stat.selected) pair = stat;
        else if (!pair && stat.state === 'succeeded') pair = stat;
      }
    }

    if (pair) {
      if (typeof pair.currentRoundTripTime === 'number') out.rttMs = Math.round(pair.currentRoundTripTime * 1000) / 1000;
      let local = pair.localCandidate ?? (pair.localCandidateId ? map.get(pair.localCandidateId) : undefined);
      let remote = pair.remoteCandidate ?? (pair.remoteCandidateId ? map.get(pair.remoteCandidateId) : undefined);
      if (!local && typeof pair.localCandidateId === 'string') local = map.get(pair.localCandidateId);
      if (!remote && typeof pair.remoteCandidateId === 'string') remote = map.get(pair.remoteCandidateId);
      const l = candidateLocation(local);
      const r = candidateLocation(remote);
      out.local = l;
      out.remote = r;
      out.pairType = l.kind === 'unknown' ? r.kind : l.kind;
      // relayed candidates give remote's relayed side; classify by either side.
      if (l.kind === 'relay' || r.kind === 'relay') out.pairType = 'relay';
    }

    // Aggregate transport counters (media + data flow through the same transport).
    let transportSeen = false;
    for (const stat of map.values()) {
      if (stat.type === 'transport') {
        transportSeen = true;
        out.bytesSent += stat.bytesSent ?? 0;
        out.bytesReceived += stat.bytesReceived ?? 0;
        out.packetsSent += stat.packetsSent ?? 0;
        out.packetsLost += stat.packetsLost ?? stat.retransmittedPacketsSent ?? 0;
        out.dtlsVersion = stat.dtlsVersion ?? out.dtlsVersion;
      }
      if (stat.type === 'sctp-transport' || stat.type === 'data-channel-transport') {
        out.bytesSent += stat.bytesSent ?? 0;
        out.bytesReceived += stat.bytesReceived ?? 0;
        if (stat.retransmittedPacketsSent) out.retransmissions += stat.retransmittedPacketsSent;
      }
    }
    if (!transportSeen) {
      for (const stat of map.values()) {
        if (stat.type === 'sctp-transport') {
          out.bytesSent += stat.bytesSent ?? 0;
          out.bytesReceived += stat.bytesReceived ?? 0;
        }
      }
    }
  } catch {
    /* getStats can race a closed connection */
  }
  return out;
}

export function kindLabel(kind: PairKind): string {
  switch (kind) {
    case 'host':
      return 'host (direct LAN)';
    case 'srflx':
      return 'srflx (public IP)';
    case 'relay':
      return 'relay (TURN)';
    default:
      return 'unknown';
  }
}

export interface CandidateInfo {
  id: string;
  kind: PairKind;
  protocol: string;
  address: string;
  port: number;
}

export interface IceReport {
  dtlsState: string | null;
  /** The nominated candidate-pair, once one exists. */
  nominated: { local: CandidateInfo | null; remote: CandidateInfo | null } | null;
  localCandidates: CandidateInfo[];
  remoteCandidates: CandidateInfo[];
}

function toInfo(cand: StatLike | undefined): CandidateInfo | null {
  if (!cand) return null;
  const { ip, port, kind } = candidateLocation(cand);
  return { id: cand.id, kind, protocol: cand.protocol ?? 'udp', address: ip, port };
}

/** Rich ICE + DTLS view for the inspector. One getStats() pass, no extra RTT. */
export async function collectIceReport(pc: RTCPeerConnection): Promise<IceReport> {
  const out: IceReport = { dtlsState: null, nominated: null, localCandidates: [], remoteCandidates: [] };
  try {
    const report = await pc.getStats();
    const map = new Map<string, StatLike>();
    report.forEach((raw) => map.set(raw.id, raw as unknown as StatLike));

    let nominated: StatLike | undefined;
    for (const stat of map.values()) {
      if (stat.type === 'transport') out.dtlsState = stat.dtlsState ?? out.dtlsState;
      if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded' && !nominated) {
        nominated = stat;
      }
    }
    if (nominated) {
      const local = nominated.localCandidate ?? (nominated.localCandidateId ? map.get(nominated.localCandidateId) : undefined);
      const remote = nominated.remoteCandidate ?? (nominated.remoteCandidateId ? map.get(nominated.remoteCandidateId) : undefined);
      out.nominated = { local: toInfo(local), remote: toInfo(remote) };
    }
    for (const stat of map.values()) {
      if (stat.type === 'local-candidate') out.localCandidates.push(toInfo(stat)!);
      if (stat.type === 'remote-candidate') out.remoteCandidates.push(toInfo(stat)!);
    }
  } catch {
    /* closing connection mid-report spawns harmless races */
  }
  return out;
}