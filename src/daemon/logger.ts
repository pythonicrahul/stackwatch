export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

type Level = 'info' | 'warn' | 'error';

/** One JSON object per line to stdout (info/warn) or stderr (error) — no
 * logging library needed for this volume/complexity, matching this
 * project's existing preference for avoiding dependencies where a few
 * lines suffice. Structured (not plain text) because the daemon's target
 * deployment environments (k8s, ECS) commonly feed container logs into
 * aggregators (CloudWatch, Loki, Datadog) that parse JSON lines directly. */
function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...fields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger: Logger = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};
