import * as cron from 'node-cron';
import { DaemonConfig, loadDaemonConfig } from './config';
import { createHealthServer, createHealthTracker } from './health';
import { logger, Logger } from './logger';
import { runDaemonCycle } from './run';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/** Loads config, or logs and exits(1) on anything invalid — the thin,
 * side-effecting wrapper around `loadDaemonConfig` (already pure/thoroughly
 * tested in config.test.ts). Extracted so this specific catch-log-exit
 * behavior is itself testable with an injected `exit`, without touching the
 * real process or global env. */
export function loadConfigOrExit(
  env: NodeJS.ProcessEnv = process.env,
  loggerInstance: Logger = logger,
  exit: (code: number) => void = (code) => process.exit(code)
): DaemonConfig | undefined {
  try {
    return loadDaemonConfig(env);
  } catch (error) {
    loggerInstance.error('invalid configuration; exiting', { error: (error as Error).message });
    exit(1);
    return undefined;
  }
}

export interface ShutdownDeps {
  cronShutdown: (timeoutMs: number) => Promise<void>;
  healthServer: { close: (callback: (err?: Error) => void) => unknown };
  logger: Logger;
  exit: (code: number) => void;
  timeoutMs?: number;
}

/** SIGTERM/SIGINT handling, extracted so it's unit-testable directly with
 * mocked collaborators rather than by sending real signals to a process —
 * mirrors this repo's existing run.ts/main.ts split (orchestration logic
 * separated from the process-level plumbing that's hard to test for real).
 * Leans on node-cron's own `shutdown()`, which stops the scheduler and
 * waits for any in-flight execution (bounded by `timeoutMs`) before
 * resolving, rather than hand-rolling in-flight-promise tracking here. */
export async function shutdown(deps: ShutdownDeps): Promise<void> {
  deps.logger.info('shutdown signal received');
  await deps.cronShutdown(deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
  await new Promise<void>((resolve) => deps.healthServer.close(() => resolve()));
  deps.logger.info('shutdown complete');
  deps.exit(0);
}

/** Real wiring — intentionally not unit tested directly (same convention as
 * main.ts): starts a real HTTP server, schedules a real cron job, and
 * registers real signal handlers. Verified for real via a spawned
 * child-process integration test and, later, real `docker run`/`docker
 * stop` in M6. */
export function bootstrap(): void {
  const config = loadConfigOrExit();
  if (!config) return;

  const tracker = createHealthTracker(config.pollIntervalMs);
  const healthServer = createHealthServer(tracker, config.healthPort, logger);

  const cycle = (): Promise<void> => runDaemonCycle({ config, logger, tracker });

  // Run once immediately rather than waiting for the first cron tick, so a
  // freshly-started container reports real status as soon as possible.
  void cycle();

  cron.schedule(config.cronExpression, cycle, { noOverlap: true });
  logger.info('daemon started', { cronExpression: config.cronExpression, vendors: config.subscribers.flatMap((s) => s.vendors) });

  const handleSignal = (signal: string): void => {
    logger.info('received signal', { signal });
    void shutdown({
      cronShutdown: cron.shutdown,
      healthServer,
      logger,
      exit: (code) => process.exit(code),
    });
  };
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
}
