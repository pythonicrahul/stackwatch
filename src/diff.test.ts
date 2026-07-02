import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDiff, diff } from './diff';
import { PersistedServiceState, SCHEMA_VERSION, ServiceResult, ServiceStatus, StackState } from './types';

function serviceOf(state: StackState, name: string): PersistedServiceState {
  const service = state.services[name];
  if (!service) throw new Error(`expected state.services.${name} to be set`);
  return service;
}

const NOW_ISO = '2026-07-01T12:00:00.000Z';
const PAST_ISO = '2026-07-01T10:30:00.000Z'; // 90 minutes before NOW_ISO

function stateOf(service?: PersistedServiceState): StackState {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: PAST_ISO,
    services: service ? { svc: service } : {},
  };
}

function resultOf(status: ServiceStatus, description = 'desc'): ServiceResult {
  return { name: 'svc', status, description, fetchedAt: NOW_ISO };
}

describe('diff — PRD Section 12 truth table', () => {
  it('undefined -> operational: do nothing', () => {
    const d = diff(stateOf(), [resultOf('operational')]);
    expect(d).toEqual({ hasChanges: false, newIncidents: [], recovered: [] });
  });

  it('undefined -> degraded/down: new incident', () => {
    const d = diff(stateOf(), [resultOf('degraded_performance')]);
    expect(d.hasChanges).toBe(true);
    expect(d.newIncidents).toEqual([resultOf('degraded_performance')]);
    expect(d.recovered).toEqual([]);
  });

  it('operational -> operational: steady healthy, do nothing', () => {
    const prev = stateOf({ status: 'operational', since: PAST_ISO, alertedAt: null });
    const d = diff(prev, [resultOf('operational')]);
    expect(d.hasChanges).toBe(false);
  });

  it('operational -> degraded/down: new incident', () => {
    const prev = stateOf({ status: 'operational', since: PAST_ISO, alertedAt: null });
    const d = diff(prev, [resultOf('major_outage')]);
    expect(d.newIncidents).toHaveLength(1);
    expect(d.recovered).toHaveLength(0);
  });

  it('degraded/down -> operational, alertedAt set: recovered', () => {
    const prev = stateOf({ status: 'major_outage', since: PAST_ISO, alertedAt: PAST_ISO });
    const d = diff(prev, [resultOf('operational')]);
    expect(d.recovered).toEqual([resultOf('operational')]);
    expect(d.newIncidents).toEqual([]);
  });

  it('degraded/down -> operational, alertedAt null: recovered (per table, "alertedAt: any")', () => {
    const prev = stateOf({ status: 'major_outage', since: PAST_ISO, alertedAt: null });
    const d = diff(prev, [resultOf('operational')]);
    expect(d.recovered).toHaveLength(1);
  });

  it('degraded/down -> same status, alertedAt non-null: ongoing, silenced', () => {
    const prev = stateOf({ status: 'major_outage', since: PAST_ISO, alertedAt: PAST_ISO });
    const d = diff(prev, [resultOf('major_outage')]);
    expect(d.hasChanges).toBe(false);
  });

  it('degraded/down -> same status, alertedAt null: retry alert (write failed last run)', () => {
    const prev = stateOf({ status: 'major_outage', since: PAST_ISO, alertedAt: null });
    const d = diff(prev, [resultOf('major_outage')]);
    expect(d.newIncidents).toHaveLength(1);
  });

  it('degraded/down -> different degraded, alertedAt non-null: ongoing, silenced', () => {
    const prev = stateOf({ status: 'degraded_performance', since: PAST_ISO, alertedAt: PAST_ISO });
    const d = diff(prev, [resultOf('major_outage')]);
    expect(d.hasChanges).toBe(false);
  });

  it('degraded/down -> different degraded, alertedAt null: retry alert', () => {
    const prev = stateOf({ status: 'degraded_performance', since: PAST_ISO, alertedAt: null });
    const d = diff(prev, [resultOf('major_outage')]);
    expect(d.newIncidents).toHaveLength(1);
  });

  it('operational -> unknown: new incident (P-6, fail loud on unreachable)', () => {
    const prev = stateOf({ status: 'operational', since: PAST_ISO, alertedAt: null });
    const d = diff(prev, [resultOf('unknown')]);
    expect(d.newIncidents).toHaveLength(1);
  });

  it('already-alerted unknown -> unknown: stays silenced (no repeat-alert spam, per P-3/G-3)', () => {
    const prev = stateOf({ status: 'unknown', since: PAST_ISO, alertedAt: PAST_ISO });
    const d = diff(prev, [resultOf('unknown')]);
    expect(d.hasChanges).toBe(false);
  });

  it('maintenance -> operational: not a recovery (never alerted going in)', () => {
    const prev = stateOf({ status: 'maintenance', since: PAST_ISO, alertedAt: null });
    const d = diff(prev, [resultOf('operational')]);
    expect(d.hasChanges).toBe(false);
  });

  it('operational -> maintenance: no alert (scheduled maintenance must not page anyone, P-1)', () => {
    const prev = stateOf({ status: 'operational', since: PAST_ISO, alertedAt: null });
    const d = diff(prev, [resultOf('maintenance')]);
    expect(d.hasChanges).toBe(false);
  });

  it('undefined -> maintenance: no alert', () => {
    const d = diff(stateOf(), [resultOf('maintenance')]);
    expect(d.hasChanges).toBe(false);
  });

  it('diffs multiple services independently in one call', () => {
    const previous: StackState = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: PAST_ISO,
      services: {
        healthy: { status: 'operational', since: PAST_ISO, alertedAt: null },
        broken: { status: 'major_outage', since: PAST_ISO, alertedAt: PAST_ISO },
        recovering: { status: 'partial_outage', since: PAST_ISO, alertedAt: PAST_ISO },
      },
    };
    const results: ServiceResult[] = [
      { name: 'healthy', status: 'operational', description: 'ok', fetchedAt: NOW_ISO },
      { name: 'broken', status: 'major_outage', description: 'still down', fetchedAt: NOW_ISO },
      { name: 'recovering', status: 'operational', description: 'ok now', fetchedAt: NOW_ISO },
      { name: 'newVendor', status: 'degraded_performance', description: 'new problem', fetchedAt: NOW_ISO },
    ];
    const d = diff(previous, results);
    expect(d.hasChanges).toBe(true);
    expect(d.newIncidents.map((r) => r.name)).toEqual(['newVendor']);
    expect(d.recovered.map((r) => r.name)).toEqual(['recovering']);
  });
});

describe('applyDiff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets alertedAt and since=now for a brand-new incident', () => {
    const prev = stateOf();
    const results = [resultOf('major_outage')];
    const d = diff(prev, results);
    const next = applyDiff(prev, results, d);
    expect(next.services.svc).toEqual({ status: 'major_outage', since: NOW_ISO, alertedAt: NOW_ISO });
  });

  it('preserves original incident-start `since` on a retry alert', () => {
    const prev = stateOf({ status: 'major_outage', since: PAST_ISO, alertedAt: null });
    const results = [resultOf('major_outage')];
    const d = diff(prev, results);
    const next = applyDiff(prev, results, d);
    expect(serviceOf(next, 'svc').since).toBe(PAST_ISO);
    expect(serviceOf(next, 'svc').alertedAt).toBe(NOW_ISO);
  });

  it('resets alertedAt to null and since=now on recovery', () => {
    const prev = stateOf({ status: 'major_outage', since: PAST_ISO, alertedAt: PAST_ISO });
    const results = [resultOf('operational')];
    const d = diff(prev, results);
    const next = applyDiff(prev, results, d);
    expect(next.services.svc).toEqual({ status: 'operational', since: NOW_ISO, alertedAt: null });
  });

  it('preserves the incident anchor (since + alertedAt) while ongoing/silenced', () => {
    const prev = stateOf({ status: 'degraded_performance', since: PAST_ISO, alertedAt: PAST_ISO });
    const results = [resultOf('major_outage')]; // severity changed, but still silenced
    const d = diff(prev, results);
    const next = applyDiff(prev, results, d);
    expect(next.services.svc).toEqual({ status: 'major_outage', since: PAST_ISO, alertedAt: PAST_ISO });
  });

  it('carries forward steady-healthy services untouched', () => {
    // A second, changing service is what makes hasChanges true and triggers a write.
    const previous: StackState = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: PAST_ISO,
      services: {
        svc: { status: 'operational', since: PAST_ISO, alertedAt: null },
        other: { status: 'operational', since: PAST_ISO, alertedAt: null },
      },
    };
    const results: ServiceResult[] = [
      resultOf('operational'),
      { name: 'other', status: 'major_outage', description: 'broke', fetchedAt: NOW_ISO },
    ];
    const d = diff(previous, results);
    const next = applyDiff(previous, results, d);
    expect(next.services.svc).toEqual({ status: 'operational', since: PAST_ISO, alertedAt: null });
  });

  it('stamps schemaVersion and updatedAt on the returned state', () => {
    const prev = stateOf();
    const results = [resultOf('major_outage')];
    const d = diff(prev, results);
    const next = applyDiff(prev, results, d);
    expect(next.schemaVersion).toBe(SCHEMA_VERSION);
    expect(next.updatedAt).toBe(NOW_ISO);
  });
});
