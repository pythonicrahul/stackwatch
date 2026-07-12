import * as fs from 'fs';
import { SUPPORTED_VENDOR_IDS } from '../fetchers';
import { VendorId } from '../types';
import { isValidSlackWebhook } from '../validation';

/** A single notification target: one webhook, watching one subset of
 * vendors. Phase 1 only ever produces exactly one of these (see
 * `loadDaemonConfig` below) but `DaemonConfig.subscribers` is a list from
 * day one, so state, the run loop, and the fan-out step are already correct
 * for N subscribers — a later phase only needs to change how this list is
 * *parsed* (e.g. from a `SUBSCRIBERS` JSON array instead of flat env vars),
 * not how it's used. See README's "Roadmap" section for the phase-2 plan
 * this is deliberately shaped for. */
export interface Subscriber {
  name: string;
  slackWebhook: string;
  vendors: VendorId[];
}

export interface DaemonConfig {
  subscribers: Subscriber[];
  cronExpression: string;
  /** Expected gap between polls, in milliseconds — used only for the health
   * endpoint's staleness threshold (createHealthTracker), NOT derived from
   * `cronExpression` itself. Cron expressions can express irregular
   * schedules (e.g. weekday-only) that don't reduce to a fixed interval, so
   * rather than parsing cron syntax to guess one, this is set independently
   * and defaults to match the default cron expression. If you override
   * `CRON_EXPRESSION` to something with a different effective gap, override
   * this too, or the health check's staleness threshold won't match reality. */
  pollIntervalMs: number;
  stateFilePath: string;
  healthPort: number;
}

const DEFAULT_CRON_EXPRESSION = '*/5 * * * *';
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_STATE_FILE_PATH = '/data/state.json';
const DEFAULT_HEALTH_PORT = 8080;

/** Resolves a secret-shaped config value: checks `<NAME>_FILE` first (reads
 * and trims the file at that path — the same convention several official
 * images use, e.g. Postgres's `POSTGRES_PASSWORD_FILE`), falling back to the
 * literal `<NAME>` env var. This composes with k8s Secret volumes, Docker
 * Swarm secrets, and Vault Agent injector sidecars without any per-backend
 * integration code — whichever mechanism materializes the value as a file
 * or a plain env var, this function doesn't need to know which. Never logs
 * the resolved value. */
export function resolveSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  return env[name];
}

function parseVendors(raw: string | undefined): VendorId[] {
  if (!raw || raw.trim() === '') {
    throw new Error('VENDORS is required (comma-separated, e.g. "github,datadog").');
  }
  const requested = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const unknown = requested.filter((v) => !SUPPORTED_VENDOR_IDS.includes(v as VendorId));
  if (unknown.length > 0) {
    throw new Error(`Unknown vendor id(s): ${unknown.join(', ')}. Supported: ${SUPPORTED_VENDOR_IDS.join(', ')}.`);
  }
  return requested as VendorId[];
}

/** `0` is deliberately valid (not just 1-65535) — the standard "let the OS
 * assign a free port" convention (as used by Node's own `server.listen(0)`),
 * useful for tests and any deployment where the actual port is discovered
 * from the daemon's own startup log rather than fixed in advance. */
function parseHealthPort(raw: string | undefined): number {
  if (!raw || raw.trim() === '') return DEFAULT_HEALTH_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`HEALTH_PORT must be a valid port number (0-65535), got "${raw}".`);
  }
  return port;
}

function parsePollIntervalMs(raw: string | undefined): number {
  if (!raw || raw.trim() === '') return DEFAULT_POLL_INTERVAL_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`POLL_INTERVAL_MS must be a positive number, got "${raw}".`);
  }
  return ms;
}

/** Fail-fast, pure validation — no `process.exit`, just throws on anything
 * invalid. The thin entrypoint (`daemon/index.ts`) calls this and handles
 * logging + `process.exit(1)` itself, mirroring this repo's existing
 * pure-function/thin-entrypoint split (see `run.ts`/`main.ts`). `env` is
 * injectable for testing rather than reaching for global `process.env`
 * throughout. */
export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const slackWebhook = resolveSecret('SLACK_WEBHOOK', env);
  if (!slackWebhook) {
    throw new Error('SLACK_WEBHOOK (or SLACK_WEBHOOK_FILE) is required.');
  }
  if (!isValidSlackWebhook(slackWebhook)) {
    throw new Error(
      'SLACK_WEBHOOK does not look like a Slack incoming webhook URL (expected https://hooks.slack.com/services/...).'
    );
  }

  const vendors = parseVendors(env.VENDORS);

  return {
    subscribers: [{ name: 'default', slackWebhook, vendors }],
    cronExpression: env.CRON_EXPRESSION?.trim() || DEFAULT_CRON_EXPRESSION,
    pollIntervalMs: parsePollIntervalMs(env.POLL_INTERVAL_MS),
    stateFilePath: env.STATE_FILE_PATH?.trim() || DEFAULT_STATE_FILE_PATH,
    healthPort: parseHealthPort(env.HEALTH_PORT),
  };
}
