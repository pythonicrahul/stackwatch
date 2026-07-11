import * as core from '@actions/core';
import { buildAlertBlocks, sendSlackAlert } from './alert';
import { loadConfig } from './config';
import { applyDiff, diff } from './diff';
import { fetchEnabledServices } from './fetchers';
import { readState, writeState } from './state';
import { writeRunSummary } from './summary';
import { DiffResult } from './types';

function setDiffOutputs(diffResult: DiffResult, alertSent: boolean): void {
  core.setOutput('has_incidents', diffResult.newIncidents.length > 0);
  core.setOutput('new_incident_count', diffResult.newIncidents.length);
  core.setOutput('recovered_count', diffResult.recovered.length);
  core.setOutput('alert_sent', alertSent);
}

/** Core orchestration: config -> fetch -> read state -> diff -> alert ->
 * write state. Split out of main.ts so it can be unit tested by mocking its
 * collaborators, without main.ts's top-level `run().catch(...)` side effect
 * firing on import. */
export async function run(): Promise<void> {
  const config = loadConfig();

  if (config.enabledVendors.length === 0) {
    core.warning('stackwatch: no monitor_* input is enabled; nothing to do.');
    setDiffOutputs({ hasChanges: false, newIncidents: [], recovered: [] }, false);
    return;
  }

  const results = await fetchEnabledServices(config.enabledVendors);
  const previous = await readState();
  const diffResult = diff(previous, results);

  if (!diffResult.hasChanges) {
    core.info('stackwatch: no state changes detected; staying silent.');
    setDiffOutputs(diffResult, false);
    await writeRunSummary(results, diffResult, 'silent');
    return;
  }

  const blocks = buildAlertBlocks(diffResult, previous);

  try {
    await sendSlackAlert(config.slackWebhook, blocks);
  } catch (error) {
    // FR-16/FR-26: alert failed to send, so state MUST NOT be written — the
    // next run retries from the same previous state.
    core.setFailed(`stackwatch: failed to send Slack alert: ${(error as Error).message}`);
    setDiffOutputs(diffResult, false);
    await writeRunSummary(results, diffResult, 'alert_failed');
    return;
  }

  const nextState = applyDiff(previous, results, diffResult);
  await writeState(nextState);

  setDiffOutputs(diffResult, true);
  await writeRunSummary(results, diffResult, 'alert_sent');

  core.info(
    `stackwatch: sent alert for ${diffResult.newIncidents.length} new incident(s) and ${diffResult.recovered.length} recovery(ies).`
  );
}
