import * as core from '@actions/core';
import { VendorId } from './types';

export interface Config {
  slackWebhook: string;
  enabledVendors: VendorId[];
}

/** Maps each supported vendor to its `monitor_*` action input. Adding a
 * vendor means adding one entry here plus a registration in
 * fetchers/index.ts and action.yml. */
const VENDOR_INPUTS: Record<VendorId, string> = {
  github: 'monitor_github',
  datadog: 'monitor_datadog',
  clickhouse: 'monitor_clickhouse',
  claude: 'monitor_claude',
};

/** Reads action inputs. Booleans MUST go through `core.getBooleanInput` —
 * string comparison to `'true'` is a forbidden antipattern (FR-4). Throws if
 * `slack_webhook` is missing (FR-1). */
export function loadConfig(): Config {
  const slackWebhook = core.getInput('slack_webhook', { required: true });

  const enabledVendors = (Object.keys(VENDOR_INPUTS) as VendorId[]).filter((vendor) =>
    core.getBooleanInput(VENDOR_INPUTS[vendor])
  );

  return { slackWebhook, enabledVendors };
}
