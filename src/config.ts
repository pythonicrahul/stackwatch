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

/** `core.getBooleanInput` throws on a value it can't parse as a YAML 1.2
 * boolean — including an entirely absent input. In normal operation the
 * Actions runner always injects each input's `action.yml` default first, so
 * this never happens; but that's an external guarantee, not something this
 * code controls (e.g. it doesn't hold running the compiled bundle directly,
 * or under `act`). Defaulting an absent input ourselves keeps FR-2's "every
 * monitor_* defaults to false" true regardless of the caller, while every
 * value that *is* present still goes through strict `getBooleanInput`
 * parsing (FR-4). */
function getBooleanInputOrDefault(name: string, defaultValue: boolean): boolean {
  return core.getInput(name).trim() === '' ? defaultValue : core.getBooleanInput(name);
}

/** Reads action inputs. Booleans MUST go through `core.getBooleanInput` —
 * string comparison to `'true'` is a forbidden antipattern (FR-4). Throws if
 * `slack_webhook` is missing (FR-1). */
export function loadConfig(): Config {
  const slackWebhook = core.getInput('slack_webhook', { required: true });

  const enabledVendors = (Object.keys(VENDOR_INPUTS) as VendorId[]).filter((vendor) =>
    getBooleanInputOrDefault(VENDOR_INPUTS[vendor], false)
  );

  return { slackWebhook, enabledVendors };
}
