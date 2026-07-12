import { describe, expect, it, vi } from 'vitest';
import { loadConfigOrExit, shutdown } from './bootstrap';
import { Logger } from './logger';

const VALID_WEBHOOK = 'https://hooks.slack.com/services/T000/B000/xxxxxxxxxxxxxxxxxxxxxxxx';

function fakeLogger(): Logger & { calls: { level: string; message: string; fields?: unknown }[] } {
  const calls: { level: string; message: string; fields?: unknown }[] = [];
  return {
    calls,
    info: (message, fields) => calls.push({ level: 'info', message, fields }),
    warn: (message, fields) => calls.push({ level: 'warn', message, fields }),
    error: (message, fields) => calls.push({ level: 'error', message, fields }),
  };
}

describe('loadConfigOrExit', () => {
  it('returns the loaded config without calling exit when the env is valid', () => {
    const exit = vi.fn();
    const logger = fakeLogger();

    const config = loadConfigOrExit({ SLACK_WEBHOOK: VALID_WEBHOOK, VENDORS: 'github' }, logger, exit);

    expect(config?.subscribers).toEqual([{ name: 'default', slackWebhook: VALID_WEBHOOK, vendors: ['github'] }]);
    expect(exit).not.toHaveBeenCalled();
    expect(logger.calls).toEqual([]);
  });

  it('logs a clear fatal error and calls exit(1) — does not throw — when the env is invalid', () => {
    const exit = vi.fn();
    const logger = fakeLogger();

    const config = loadConfigOrExit({}, logger, exit);

    expect(config).toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logger.calls).toEqual([
      { level: 'error', message: 'invalid configuration; exiting', fields: { error: expect.stringContaining('SLACK_WEBHOOK') } },
    ]);
  });

  it('never logs the resolved webhook value itself while reporting a validation error', () => {
    const exit = vi.fn();
    const logger = fakeLogger();
    const secretWebhook = 'https://hooks.slack.com/services/T000/B000/super-secret';

    loadConfigOrExit({ SLACK_WEBHOOK: secretWebhook, VENDORS: 'not-a-real-vendor' }, logger, exit);

    const loggedText = JSON.stringify(logger.calls);
    expect(loggedText).not.toContain(secretWebhook);
  });
});

describe('shutdown', () => {
  it('stops the cron scheduler (bounded by the timeout), closes the health server, logs, then exits(0), in that order', async () => {
    const callOrder: string[] = [];
    const cronShutdown = vi.fn().mockImplementation(async (timeoutMs: number) => {
      callOrder.push(`cronShutdown:${timeoutMs}`);
    });
    const healthServer = {
      close: vi.fn((callback: (err?: Error) => void) => {
        callOrder.push('healthServer.close');
        callback();
      }),
    };
    const exit = vi.fn((code: number) => callOrder.push(`exit:${code}`));
    const logger = fakeLogger();

    await shutdown({ cronShutdown, healthServer, logger, exit, timeoutMs: 5000 });

    expect(cronShutdown).toHaveBeenCalledWith(5000);
    expect(healthServer.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(callOrder).toEqual(['cronShutdown:5000', 'healthServer.close', 'exit:0']);
    expect(logger.calls.map((c) => c.message)).toEqual(['shutdown signal received', 'shutdown complete']);
  });

  it('uses a sensible default timeout when none is given', async () => {
    const cronShutdown = vi.fn().mockResolvedValue(undefined);
    const healthServer = { close: vi.fn((cb: () => void) => cb()) };

    await shutdown({ cronShutdown, healthServer, logger: fakeLogger(), exit: vi.fn() });

    expect(cronShutdown).toHaveBeenCalledWith(30_000);
  });

  it('still closes the health server and exits even if cronShutdown itself takes the full timeout', async () => {
    const cronShutdown = vi.fn().mockImplementation((timeoutMs: number) => new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5))));
    const healthServer = { close: vi.fn((cb: () => void) => cb()) };
    const exit = vi.fn();

    await shutdown({ cronShutdown, healthServer, logger: fakeLogger(), exit, timeoutMs: 5 });

    expect(healthServer.close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
