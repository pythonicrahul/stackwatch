import * as http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHealthServer, createHealthTracker } from './health';
import { Logger } from './logger';

const INTERVAL_MS = 5 * 60_000; // 5 minutes, matches the daemon's default cron

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** A mutable, injectable clock so tests can move time forward without fake
 * timers or real elapsed time. */
function testClock(startAt: number) {
  let current = startAt;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('createHealthTracker', () => {
  it('reports "starting" (not "unhealthy") before the first poll completes, within the startup grace period', () => {
    const clock = testClock(1_000_000);
    const tracker = createHealthTracker(INTERVAL_MS, clock.now);

    clock.advance(INTERVAL_MS / 2); // still within one interval of startup
    const status = tracker.getStatus();

    expect(status.state).toBe('starting');
    expect(status.healthy).toBe(true);
    expect(status.lastSuccessAt).toBeNull();
  });

  it('reports "stale" if the startup grace period elapses with no successful poll', () => {
    const clock = testClock(1_000_000);
    const tracker = createHealthTracker(INTERVAL_MS, clock.now);

    clock.advance(INTERVAL_MS * 1.5); // past the one-interval startup grace

    expect(tracker.getStatus()).toMatchObject({ state: 'stale', healthy: false });
  });

  it('reports "healthy" shortly after a successful poll', () => {
    const clock = testClock(1_000_000);
    const tracker = createHealthTracker(INTERVAL_MS, clock.now);

    tracker.recordPollStart();
    tracker.recordPollSuccess();
    clock.advance(INTERVAL_MS / 2);

    expect(tracker.getStatus()).toMatchObject({ state: 'healthy', healthy: true });
  });

  it('reports "stale" once too long has passed since the last successful poll', () => {
    const clock = testClock(1_000_000);
    const tracker = createHealthTracker(INTERVAL_MS, clock.now);

    tracker.recordPollSuccess();
    clock.advance(INTERVAL_MS * 3); // past the 2-interval staleness threshold

    expect(tracker.getStatus()).toMatchObject({ state: 'stale', healthy: false });
  });

  it('clears lastError on a subsequent success, and reports it while set', () => {
    const clock = testClock(1_000_000);
    const tracker = createHealthTracker(INTERVAL_MS, clock.now);

    tracker.recordPollFailure('vendor fetch timed out');
    expect(tracker.getStatus().lastError).toBe('vendor fetch timed out');

    tracker.recordPollSuccess();
    expect(tracker.getStatus().lastError).toBeNull();
  });

  it('a failed poll alone does not make it healthy again once already stale', () => {
    const clock = testClock(1_000_000);
    const tracker = createHealthTracker(INTERVAL_MS, clock.now);

    tracker.recordPollSuccess();
    clock.advance(INTERVAL_MS * 3);
    tracker.recordPollFailure('still down');

    expect(tracker.getStatus()).toMatchObject({ state: 'stale', healthy: false });
  });
});

describe('createHealthServer', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  function boundPort(s: http.Server): number {
    const address = s.address();
    if (typeof address !== 'object' || !address) throw new Error('server not listening');
    return address.port;
  }

  async function get(port: number, urlPath: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`);
    return { status: response.status, body: await response.json().catch(() => undefined) };
  }

  it('responds 200 with the tracker status while healthy', async () => {
    const clock = testClock(1_000_000);
    const tracker = createHealthTracker(INTERVAL_MS, clock.now);
    tracker.recordPollSuccess();
    server = createHealthServer(tracker, 0, silentLogger());
    await new Promise((resolve) => server?.once('listening', resolve));

    const { status, body } = await get(boundPort(server), '/healthz');

    expect(status).toBe(200);
    expect(body).toMatchObject({ healthy: true, state: 'healthy' });
  });

  it('responds 503 once the tracker reports stale', async () => {
    const clock = testClock(1_000_000);
    const tracker = createHealthTracker(INTERVAL_MS, clock.now);
    clock.advance(INTERVAL_MS * 3);
    server = createHealthServer(tracker, 0, silentLogger());
    await new Promise((resolve) => server?.once('listening', resolve));

    const { status, body } = await get(boundPort(server), '/healthz');

    expect(status).toBe(503);
    expect(body).toMatchObject({ healthy: false, state: 'stale' });
  });

  it('404s on anything other than GET /healthz', async () => {
    const tracker = createHealthTracker(INTERVAL_MS);
    server = createHealthServer(tracker, 0, silentLogger());
    await new Promise((resolve) => server?.once('listening', resolve));

    const { status } = await get(boundPort(server), '/not-healthz');

    expect(status).toBe(404);
  });
});
