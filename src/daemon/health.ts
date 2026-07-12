import * as http from 'http';
import { Logger } from './logger';

export type HealthState = 'starting' | 'healthy' | 'stale';

export interface HealthStatus {
  healthy: boolean;
  state: HealthState;
  startedAt: string;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface HealthTracker {
  recordPollStart(): void;
  recordPollSuccess(): void;
  recordPollFailure(error: string): void;
  getStatus(): HealthStatus;
}

/** Multiplier applied to the poll interval to decide "stale" (no successful
 * poll recently enough). Loose on purpose — this only needs to catch a
 * scheduler that's actually died, not flag a single slow cycle. */
const STALE_AFTER_INTERVALS = 2;
/** Grace period, in units of the poll interval, before the very first poll
 * completes. Without this, a k8s readiness probe with no startup grace
 * could kill the pod before it ever gets to poll once. */
const STARTUP_GRACE_INTERVALS = 1;

/** Pure state tracker, deliberately separate from the HTTP server below —
 * a future `/metrics` endpoint can read the same tracker without depending
 * on the HTTP layer at all. `now` is injectable so tests don't need fake
 * timers or real elapsed time. */
export function createHealthTracker(intervalMs: number, now: () => number = Date.now): HealthTracker {
  const startedAt = now();
  let lastPollAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastError: string | null = null;

  return {
    recordPollStart() {
      lastPollAt = now();
    },
    recordPollSuccess() {
      lastSuccessAt = now();
      lastError = null;
    },
    recordPollFailure(error: string) {
      lastError = error;
    },
    getStatus(): HealthStatus {
      const currentTime = now();
      let state: HealthState;
      if (lastSuccessAt === null) {
        const withinStartupGrace = currentTime - startedAt <= intervalMs * STARTUP_GRACE_INTERVALS;
        state = withinStartupGrace ? 'starting' : 'stale';
      } else {
        const withinFreshness = currentTime - lastSuccessAt <= intervalMs * STALE_AFTER_INTERVALS;
        state = withinFreshness ? 'healthy' : 'stale';
      }
      return {
        healthy: state !== 'stale',
        state,
        startedAt: new Date(startedAt).toISOString(),
        lastPollAt: lastPollAt === null ? null : new Date(lastPollAt).toISOString(),
        lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
        lastError,
      };
    },
  };
}

/** Thin GET /healthz server: 200 while healthy/starting, 503 once stale.
 * Anything else 404s. Caller owns the returned server's lifecycle (close it
 * on shutdown). */
export function createHealthServer(tracker: HealthTracker, port: number, logger: Logger): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const status = tracker.getStatus();
    res.writeHead(status.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  });
  server.listen(port, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    logger.info('health server listening', { port: boundPort });
  });
  return server;
}
