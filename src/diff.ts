import { DiffResult, PersistedServiceState, ServiceResult, SCHEMA_VERSION, StackState, isAlertable } from './types';

/**
 * Pure diff engine — no I/O, no side effects (FR-17). Classifies every
 * fetched result against previously persisted state per the truth table in
 * PRD Section 12.
 *
 * Note on the table's "any -> unknown = new incident" row: read literally
 * that would re-alert every run while a service stays unreachable, which
 * directly conflicts with the non-negotiable P-3/G-3 no-repeat-alert
 * principles. We treat `unknown` as just another alertable status subject to
 * the same ongoing/silenced rule as `degraded_performance` etc. — it still
 * always triggers a *new* incident the first time a service goes from
 * healthy/unset to unreachable (satisfying P-6), it just doesn't re-fire
 * every 5 minutes once already alerted.
 */
export function diff(previous: StackState, results: ServiceResult[]): DiffResult {
  const newIncidents: ServiceResult[] = [];
  const recovered: ServiceResult[] = [];

  for (const result of results) {
    const prev = previous.services[result.name];

    if (isAlertable(result.status)) {
      if (!prev || !isAlertable(prev.status)) {
        newIncidents.push(result); // undefined / operational / maintenance -> alertable
      } else if (prev.alertedAt === null) {
        newIncidents.push(result); // still alertable, but last run's alert write never landed
      }
      // else: alertable -> alertable with alertedAt set = ongoing, silenced (FR-20)
    } else if (result.status === 'operational' && prev && isAlertable(prev.status)) {
      recovered.push(result);
    }
    // steady healthy, steady/entering maintenance, or newly-observed healthy: do nothing
  }

  return {
    hasChanges: newIncidents.length > 0 || recovered.length > 0,
    newIncidents,
    recovered,
  };
}

/**
 * Computes the next state to persist after a diff, given every fetched
 * result. Callers MUST only persist this — and only call it at all — when
 * `diffResult.hasChanges` is true and the resulting alert has already been
 * sent successfully (FR-16, FR-21).
 */
export function applyDiff(previous: StackState, results: ServiceResult[], diffResult: DiffResult): StackState {
  const now = new Date().toISOString();
  const alertedNames = new Set(diffResult.newIncidents.map((r) => r.name));
  const recoveredNames = new Set(diffResult.recovered.map((r) => r.name));

  const services: Record<string, PersistedServiceState> = {};

  for (const result of results) {
    const prev = previous.services[result.name];

    if (alertedNames.has(result.name)) {
      const since = prev && isAlertable(prev.status) ? prev.since : now;
      services[result.name] = { status: result.status, since, alertedAt: now };
      continue;
    }

    if (recoveredNames.has(result.name)) {
      services[result.name] = { status: result.status, since: now, alertedAt: null };
      continue;
    }

    if (prev && isAlertable(prev.status) && isAlertable(result.status)) {
      // ongoing, silenced incident: keep the original incident anchor, refresh status/description
      services[result.name] = { status: result.status, since: prev.since, alertedAt: prev.alertedAt };
      continue;
    }

    // steady healthy, steady maintenance, or newly-observed healthy/maintenance
    services[result.name] = {
      status: result.status,
      since: prev?.since ?? now,
      alertedAt: prev?.alertedAt ?? null,
    };
  }

  return { schemaVersion: SCHEMA_VERSION, updatedAt: now, services };
}
