import * as core from '@actions/core';
import { STATUS_EMOJI, STATUS_LABEL } from './alert';
import { DiffResult, ServiceResult } from './types';

export type RunOutcome = 'silent' | 'alert_sent' | 'alert_failed';

const OUTCOME_TEXT: Record<RunOutcome, string> = {
  silent: 'No changes detected — staying silent.',
  alert_sent: 'Alert sent to Slack.',
  alert_failed: 'Alert failed to send to Slack — state was not persisted, so the next run will retry.',
};

/** Writes a per-vendor status table to the GitHub Actions job summary, so a
 * run's outcome is visible at a glance in the Actions UI without opening
 * logs — including on a totally silent, healthy run. Purely additive: never
 * affects alerting or state persistence, and a failure here is logged, not
 * thrown. */
export async function writeRunSummary(results: ServiceResult[], diffResult: DiffResult, outcome: RunOutcome): Promise<void> {
  const newIncidentNames = new Set(diffResult.newIncidents.map((r) => r.name));
  const recoveredNames = new Set(diffResult.recovered.map((r) => r.name));

  const rows = results.map((result) => {
    const thisRun = newIncidentNames.has(result.name) ? '🔔 New incident' : recoveredNames.has(result.name) ? '✅ Recovered' : '—';
    return [result.name, `${STATUS_EMOJI[result.status]} ${STATUS_LABEL[result.status]}`, thisRun];
  });

  try {
    await core.summary
      .addHeading('stackwatch', 2)
      .addTable([
        [
          { data: 'Vendor', header: true },
          { data: 'Status', header: true },
          { data: 'This run', header: true },
        ],
        ...rows,
      ])
      .addRaw(OUTCOME_TEXT[outcome], true)
      .write();
  } catch (error) {
    core.warning(`stackwatch: failed to write job summary: ${(error as Error).message}`);
  }
}
