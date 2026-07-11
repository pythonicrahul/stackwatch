import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const originalEnv = { ...process.env };
const VALID_WEBHOOK = 'https://hooks.slack.com/services/T000/B000/xxxxxxxxxxxxxxxxxxxxxxxx';

const INPUT_VARS = [
  'INPUT_SLACK_WEBHOOK',
  'INPUT_MONITOR_GITHUB',
  'INPUT_MONITOR_DATADOG',
  'INPUT_MONITOR_CLICKHOUSE',
  'INPUT_MONITOR_CLAUDE',
];

describe('loadConfig', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of INPUT_VARS) delete process.env[key];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws a clear error when slack_webhook is missing (FR-1)', () => {
    expect(() => loadConfig()).toThrow(/slack_webhook/);
  });

  it('throws a clear error when slack_webhook does not look like a Slack incoming webhook URL', () => {
    process.env.INPUT_SLACK_WEBHOOK = 'https://example.com/not-a-webhook';

    expect(() => loadConfig()).toThrow(/does not look like a Slack incoming webhook URL/);
  });

  it('accepts a well-formed Slack incoming webhook URL', () => {
    process.env.INPUT_SLACK_WEBHOOK = VALID_WEBHOOK;

    expect(() => loadConfig()).not.toThrow();
  });

  it('returns no enabled vendors when every monitor_* input is unset (opt-in default, P-5)', () => {
    process.env.INPUT_SLACK_WEBHOOK = VALID_WEBHOOK;

    const config = loadConfig();

    expect(config.slackWebhook).toBe(VALID_WEBHOOK);
    expect(config.enabledVendors).toEqual([]);
  });

  it('enables only the vendors whose monitor_* input is true', () => {
    process.env.INPUT_SLACK_WEBHOOK = VALID_WEBHOOK;
    process.env.INPUT_MONITOR_GITHUB = 'true';
    process.env.INPUT_MONITOR_CLICKHOUSE = 'true';
    process.env.INPUT_MONITOR_DATADOG = 'false';

    const config = loadConfig();

    expect(config.enabledVendors).toEqual(['github', 'clickhouse']);
  });

  it('enables all four vendors when all monitor_* inputs are true', () => {
    process.env.INPUT_SLACK_WEBHOOK = VALID_WEBHOOK;
    process.env.INPUT_MONITOR_GITHUB = 'true';
    process.env.INPUT_MONITOR_DATADOG = 'true';
    process.env.INPUT_MONITOR_CLICKHOUSE = 'true';
    process.env.INPUT_MONITOR_CLAUDE = 'true';

    const config = loadConfig();

    expect(config.enabledVendors).toEqual(['github', 'datadog', 'clickhouse', 'claude']);
  });

  it('accepts case-insensitive YAML booleans via getBooleanInput (e.g. "True")', () => {
    process.env.INPUT_SLACK_WEBHOOK = VALID_WEBHOOK;
    process.env.INPUT_MONITOR_GITHUB = 'True';

    const config = loadConfig();

    expect(config.enabledVendors).toEqual(['github']);
  });

  it('rejects a non-boolean value instead of silently treating it as falsy (FR-4: no string === "true" antipattern)', () => {
    process.env.INPUT_SLACK_WEBHOOK = VALID_WEBHOOK;
    process.env.INPUT_MONITOR_GITHUB = 'yes';

    expect(() => loadConfig()).toThrow();
  });
});
