import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as alert from './alert';
import * as config from './config';
import * as diffModule from './diff';
import * as fetchers from './fetchers';
import { run } from './run';
import * as state from './state';
import * as summary from './summary';
import { DiffResult, SCHEMA_VERSION, ServiceResult, StackState } from './types';

vi.mock('./config');
vi.mock('./fetchers');
vi.mock('./state');
vi.mock('./diff');
vi.mock('./alert');
vi.mock('./summary');

const EMPTY_STATE: StackState = { schemaVersion: SCHEMA_VERSION, updatedAt: '2026-07-01T12:00:00.000Z', services: {} };
const SOME_RESULTS: ServiceResult[] = [
  { name: 'GitHub', status: 'operational', description: 'ok', fetchedAt: '2026-07-01T12:00:00.000Z' },
];

describe('run', () => {
  beforeEach(() => {
    // core.setFailed mutates process.exitCode as a side effect; spy it out
    // so a "failure" test case here doesn't leak a nonzero exit code into
    // the overall test run.
    vi.spyOn(core, 'setFailed').mockImplementation(() => {});
    vi.spyOn(core, 'warning').mockImplementation(() => {});
    vi.spyOn(core, 'info').mockImplementation(() => {});
    vi.spyOn(core, 'setOutput').mockImplementation(() => {});

    vi.mocked(state.readState).mockResolvedValue(EMPTY_STATE);
    vi.mocked(state.writeState).mockResolvedValue(undefined);
    vi.mocked(fetchers.fetchEnabledServices).mockResolvedValue(SOME_RESULTS);
    vi.mocked(alert.buildAlertBlocks).mockReturnValue([]);
    vi.mocked(alert.sendSlackAlert).mockResolvedValue(undefined);
    vi.mocked(summary.writeRunSummary).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns and does nothing else when no monitor_* input is enabled (FR-3)', async () => {
    vi.mocked(config.loadConfig).mockReturnValue({ slackWebhook: 'https://hooks.slack.example/x', enabledVendors: [] });

    await run();

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('no monitor_*'));
    expect(fetchers.fetchEnabledServices).not.toHaveBeenCalled();
    expect(state.readState).not.toHaveBeenCalled();
    expect(summary.writeRunSummary).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('has_incidents', false);
    expect(core.setOutput).toHaveBeenCalledWith('alert_sent', false);
  });

  it('stays silent and does not write state when the diff has no changes (FR-21)', async () => {
    vi.mocked(config.loadConfig).mockReturnValue({ slackWebhook: 'https://hooks.slack.example/x', enabledVendors: ['github'] });
    const diffResult: DiffResult = { hasChanges: false, newIncidents: [], recovered: [] };
    vi.mocked(diffModule.diff).mockReturnValue(diffResult);

    await run();

    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('staying silent'));
    expect(alert.sendSlackAlert).not.toHaveBeenCalled();
    expect(state.writeState).not.toHaveBeenCalled();
    expect(summary.writeRunSummary).toHaveBeenCalledWith(SOME_RESULTS, diffResult, 'silent');
    expect(core.setOutput).toHaveBeenCalledWith('has_incidents', false);
    expect(core.setOutput).toHaveBeenCalledWith('new_incident_count', 0);
    expect(core.setOutput).toHaveBeenCalledWith('recovered_count', 0);
    expect(core.setOutput).toHaveBeenCalledWith('alert_sent', false);
  });

  it('sends the alert, writes the next state, sets outputs, and writes the summary when the diff has changes', async () => {
    const diffResult: DiffResult = {
      hasChanges: true,
      newIncidents: [{ name: 'GitHub', status: 'major_outage', description: 'down', fetchedAt: '2026-07-01T12:00:00.000Z' }],
      recovered: [{ name: 'Datadog', status: 'operational', description: 'ok', fetchedAt: '2026-07-01T12:00:00.000Z' }],
    };
    const nextState: StackState = { ...EMPTY_STATE, services: { GitHub: { status: 'major_outage', since: '2026-07-01T12:00:00.000Z', alertedAt: '2026-07-01T12:00:00.000Z' } } };
    const blocks = [{ type: 'section' }];

    vi.mocked(config.loadConfig).mockReturnValue({ slackWebhook: 'https://hooks.slack.example/x', enabledVendors: ['github'] });
    vi.mocked(diffModule.diff).mockReturnValue(diffResult);
    vi.mocked(alert.buildAlertBlocks).mockReturnValue(blocks as never);
    vi.mocked(diffModule.applyDiff).mockReturnValue(nextState);

    await run();

    expect(alert.buildAlertBlocks).toHaveBeenCalledWith(diffResult, EMPTY_STATE);
    expect(alert.sendSlackAlert).toHaveBeenCalledWith('https://hooks.slack.example/x', blocks);
    expect(diffModule.applyDiff).toHaveBeenCalledWith(EMPTY_STATE, SOME_RESULTS, diffResult);
    expect(state.writeState).toHaveBeenCalledWith(nextState);
    expect(core.setFailed).not.toHaveBeenCalled();

    expect(core.setOutput).toHaveBeenCalledWith('has_incidents', true);
    expect(core.setOutput).toHaveBeenCalledWith('new_incident_count', 1);
    expect(core.setOutput).toHaveBeenCalledWith('recovered_count', 1);
    expect(core.setOutput).toHaveBeenCalledWith('alert_sent', true);
    expect(summary.writeRunSummary).toHaveBeenCalledWith(SOME_RESULTS, diffResult, 'alert_sent');
  });

  it('fails loudly, does NOT write state, but still sets outputs and writes the summary when the Slack send fails (FR-16, FR-26)', async () => {
    const diffResult: DiffResult = {
      hasChanges: true,
      newIncidents: [{ name: 'GitHub', status: 'major_outage', description: 'down', fetchedAt: '2026-07-01T12:00:00.000Z' }],
      recovered: [],
    };
    vi.mocked(config.loadConfig).mockReturnValue({ slackWebhook: 'https://hooks.slack.example/x', enabledVendors: ['github'] });
    vi.mocked(diffModule.diff).mockReturnValue(diffResult);
    vi.mocked(alert.sendSlackAlert).mockRejectedValue(new Error('Slack webhook responded with status 500'));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('500'));
    expect(diffModule.applyDiff).not.toHaveBeenCalled();
    expect(state.writeState).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('alert_sent', false);
    expect(summary.writeRunSummary).toHaveBeenCalledWith(SOME_RESULTS, diffResult, 'alert_failed');
  });
});
