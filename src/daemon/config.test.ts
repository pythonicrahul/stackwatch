import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDaemonConfig, resolveSecret } from './config';

const VALID_WEBHOOK = 'https://hooks.slack.com/services/T000/B000/xxxxxxxxxxxxxxxxxxxxxxxx';

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { SLACK_WEBHOOK: VALID_WEBHOOK, VENDORS: 'github,datadog', ...overrides };
}

describe('resolveSecret', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
  });

  it('reads and trims the value from <NAME>_FILE when set, preferring it over the literal env var', () => {
    const filePath = path.join(os.tmpdir(), `stackwatch-secret-test-${Date.now()}`);
    fs.writeFileSync(filePath, '  https://hooks.slack.com/services/from-file  \n');
    tmpFiles.push(filePath);

    const resolved = resolveSecret('SLACK_WEBHOOK', {
      SLACK_WEBHOOK: 'https://hooks.slack.com/services/from-env',
      SLACK_WEBHOOK_FILE: filePath,
    });

    expect(resolved).toBe('https://hooks.slack.com/services/from-file');
  });

  it('falls back to the literal env var when <NAME>_FILE is not set', () => {
    expect(resolveSecret('SLACK_WEBHOOK', { SLACK_WEBHOOK: 'https://hooks.slack.com/services/plain' })).toBe(
      'https://hooks.slack.com/services/plain'
    );
  });

  it('returns undefined when neither is set', () => {
    expect(resolveSecret('SLACK_WEBHOOK', {})).toBeUndefined();
  });
});

describe('loadDaemonConfig', () => {
  it('produces exactly one subscriber in phase 1, from SLACK_WEBHOOK + VENDORS', () => {
    const config = loadDaemonConfig(baseEnv());

    expect(config.subscribers).toEqual([{ name: 'default', slackWebhook: VALID_WEBHOOK, vendors: ['github', 'datadog'] }]);
  });

  it('throws a clear error when SLACK_WEBHOOK is missing', () => {
    expect(() => loadDaemonConfig(baseEnv({ SLACK_WEBHOOK: undefined }))).toThrow(/SLACK_WEBHOOK/);
  });

  it('throws when SLACK_WEBHOOK does not look like a Slack incoming webhook URL', () => {
    expect(() => loadDaemonConfig(baseEnv({ SLACK_WEBHOOK: 'https://example.com/not-a-webhook' }))).toThrow(
      /does not look like a Slack incoming webhook URL/
    );
  });

  it('throws when VENDORS is missing', () => {
    expect(() => loadDaemonConfig(baseEnv({ VENDORS: undefined }))).toThrow(/VENDORS is required/);
  });

  it('throws listing unknown vendor ids, validated against the real fetcher registry (not a hand-duplicated list)', () => {
    expect(() => loadDaemonConfig(baseEnv({ VENDORS: 'github,not-a-real-vendor' }))).toThrow(/Unknown vendor id\(s\): not-a-real-vendor/);
  });

  it('trims whitespace around comma-separated vendor ids', () => {
    const config = loadDaemonConfig(baseEnv({ VENDORS: ' github , datadog ' }));
    expect(config.subscribers[0]?.vendors).toEqual(['github', 'datadog']);
  });

  it('applies sensible defaults for cron expression, poll interval, state file path, and health port', () => {
    const config = loadDaemonConfig(baseEnv());

    expect(config.cronExpression).toBe('*/5 * * * *');
    expect(config.pollIntervalMs).toBe(5 * 60_000);
    expect(config.stateFilePath).toBe('/data/state.json');
    expect(config.healthPort).toBe(8080);
  });

  it('honors overrides for cron expression, poll interval, state file path, and health port', () => {
    const config = loadDaemonConfig(
      baseEnv({
        CRON_EXPRESSION: '*/10 * * * *',
        POLL_INTERVAL_MS: '600000',
        STATE_FILE_PATH: '/custom/state.json',
        HEALTH_PORT: '9090',
      })
    );

    expect(config.cronExpression).toBe('*/10 * * * *');
    expect(config.pollIntervalMs).toBe(600_000);
    expect(config.stateFilePath).toBe('/custom/state.json');
    expect(config.healthPort).toBe(9090);
  });

  it('throws on an invalid HEALTH_PORT instead of silently coercing it', () => {
    expect(() => loadDaemonConfig(baseEnv({ HEALTH_PORT: 'not-a-port' }))).toThrow(/HEALTH_PORT must be a valid port number/);
    expect(() => loadDaemonConfig(baseEnv({ HEALTH_PORT: '-1' }))).toThrow(/HEALTH_PORT must be a valid port number/);
  });

  it('accepts HEALTH_PORT=0 — the standard "let the OS assign a free port" convention, used by tests', () => {
    expect(loadDaemonConfig(baseEnv({ HEALTH_PORT: '0' })).healthPort).toBe(0);
  });

  it('throws on an invalid POLL_INTERVAL_MS instead of silently coercing it', () => {
    expect(() => loadDaemonConfig(baseEnv({ POLL_INTERVAL_MS: '-5' }))).toThrow(/POLL_INTERVAL_MS must be a positive number/);
  });

  it('resolves SLACK_WEBHOOK via the _FILE convention too', () => {
    const filePath = path.join(os.tmpdir(), `stackwatch-webhook-${Date.now()}`);
    fs.writeFileSync(filePath, VALID_WEBHOOK);
    try {
      const config = loadDaemonConfig(baseEnv({ SLACK_WEBHOOK: undefined, SLACK_WEBHOOK_FILE: filePath }));
      expect(config.subscribers[0]?.slackWebhook).toBe(VALID_WEBHOOK);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('never logs the resolved webhook, including on a forced fatal-validation path', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretWebhook = 'https://hooks.slack.com/services/T000/B000/super-secret-value';

    // Valid load: secret must not appear in any console output.
    loadDaemonConfig(baseEnv({ SLACK_WEBHOOK: secretWebhook }));
    // Forced fatal path (bad VENDORS) with the same secret present in env.
    try {
      loadDaemonConfig(baseEnv({ SLACK_WEBHOOK: secretWebhook, VENDORS: 'not-real' }));
    } catch {
      // expected to throw — we only care that the secret never got logged
    }

    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
    expect(allLoggedText).not.toContain(secretWebhook);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
