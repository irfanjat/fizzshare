/**
 * validate.ts — strict validation of every inbound signaling message.
 *
 * Networking reasoning: the server blindly relays *payloads* between the two
 * peers but must not blindly accept *shapes*. A malformed or oversized message
 * is dropped before it reaches the peer or the room registry, which keeps the
 * control plane (and rate-limit buckets) hard to confuse.
 */

export interface CreateRoomMessage {
  type: 'create-room';
}

export interface JoinRoomMessage {
  type: 'join-room';
  code: string;
}

export interface SdpMessage {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceMessage {
  type: 'ice';
  candidate: Record<string, unknown>;
}

export interface ByeMessage {
  type: 'bye';
}

export interface TelemetryMessage {
  type: 'telemetry';
  pairType: 'host' | 'srflx' | 'relay' | 'unknown';
  rttMs?: number;
  durationMs?: number;
  bytesSent?: number;
  bytesReceived?: number;
  throughputMbps?: number;
}

/** Ask the peer to rebuild the RTCPeerConnection with a new ICE policy. */
export interface RestartMessage {
  type: 'restart';
  policy: 'auto' | 'host' | 'relay';
}

export type ClientMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | SdpMessage
  | IceMessage
  | ByeMessage
  | TelemetryMessage
  | RestartMessage;

export class InvalidMessageError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

/** Room code: 6 chars from the unambiguous alphabet (case-insensitive input). */
export const ROOM_CODE_REGEX = /^[A-HJ-NP-Z2-9]{6}$/;

const MAX_SDP_LENGTH = 900_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, minLen = 1, maxLen = 1_000_000): string {
  const v = obj[key];
  if (typeof v !== 'string') throw new InvalidMessageError(`field '${key}' must be a string`, 'BAD_MESSAGE');
  if (v.length < minLen || v.length > maxLen) {
    throw new InvalidMessageError(`field '${key}' length out of bounds`, 'BAD_MESSAGE');
  }
  return v;
}

/** Parse a raw WebSocket frame into a validated ClientMessage. */
export function parseClientMessage(raw: string): ClientMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new InvalidMessageError('invalid JSON payload', 'BAD_JSON');
  }
  if (!isPlainObject(json)) throw new InvalidMessageError('message must be a JSON object', 'BAD_MESSAGE');

  const type = json['type'];
  if (typeof type !== 'string') throw new InvalidMessageError("missing 'type'", 'BAD_MESSAGE');

  switch (type) {
    case 'create-room':
      return { type: 'create-room' };

    case 'join-room': {
      const code = requireString(json, 'code', 1, 16).trim().toUpperCase();
      if (!ROOM_CODE_REGEX.test(code)) {
        throw new InvalidMessageError('malformed room code', 'BAD_CODE');
      }
      return { type: 'join-room', code };
    }

    case 'offer':
    case 'answer': {
      const sdp = requireString(json, 'sdp', 32, MAX_SDP_LENGTH);
      return { type, sdp };
    }

    case 'ice': {
      const candidate = json['candidate'];
      if (!isPlainObject(candidate)) {
        throw new InvalidMessageError("'candidate' must be an object", 'BAD_MESSAGE');
      }
      const line = candidate['candidate'];
      if (typeof line !== 'string' || line.length < 10 || line.length > 16_384) {
        throw new InvalidMessageError("'candidate.candidate' must be a non-empty string", 'BAD_MESSAGE');
      }
      return { type: 'ice', candidate };
    }

    case 'bye':
      return { type: 'bye' };

    case 'restart': {
      const policy = json['policy'];
      if (policy !== 'auto' && policy !== 'host' && policy !== 'relay') {
        throw new InvalidMessageError("'policy' must be auto|host|relay", 'BAD_MESSAGE');
      }
      return { type: 'restart', policy };
    }

    case 'telemetry': {
      const pairType = json['pairType'];
      if (pairType !== 'host' && pairType !== 'srflx' && pairType !== 'relay' && pairType !== 'unknown') {
        throw new InvalidMessageError("'pairType' must be host|srflx|relay|unknown", 'BAD_MESSAGE');
      }
      const msg: TelemetryMessage = {
        type: 'telemetry',
        pairType,
        rttMs: numberOrUndefined(json, 'rttMs'),
        durationMs: numberOrUndefined(json, 'durationMs'),
        bytesSent: numberOrUndefined(json, 'bytesSent'),
        bytesReceived: numberOrUndefined(json, 'bytesReceived'),
        throughputMbps: numberOrUndefined(json, 'throughputMbps'),
      };
      return msg;
    }

    default:
      throw new InvalidMessageError(`unknown message type '${type}'`, 'BAD_TYPE');
  }
}

function numberOrUndefined(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v;
}