/**
 * logger.ts — structured JSON logs.
 *
 * Security rule: message payloads (SDP, ICE candidates, and especially any
 * file metadata) are NEVER logged. Only message *types* and lifecycle events
 * are recorded. This guarantees that even if logs leak, no file names or
 * contents are exposed.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

type Fields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level] ?? ORDER.info;

  function write(lvl: LogLevel, event: string, fields?: Fields): void {
    if (ORDER[lvl] < threshold) return;
    const rec: Record<string, string | number | boolean | null> = {
      ts: new Date().toISOString(),
      level: lvl,
      event,
    };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) rec[k] = v;
      }
    }
    const line = JSON.stringify(rec);
    if (lvl === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
  };
}

export const logger: Logger = createLogger(
  (process.env.LOG_LEVEL as LogLevel) ?? 'info',
);