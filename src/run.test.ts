import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as alert from './alert';
import * as config from './config';
import * as diffModule from './diff';
import * as fetchers from './fetchers';
import { run } from './run';
import * as state from './state';
import { DiffResult, SCHEMA_VERSION, ServiceResult, StackState } from './types';

vi.mock('./config');
vi.mock('./fetchers');
vi.mock('./state');
vi.mock('./diff');
vi.mock('./alert');

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

    vi.mocked(state.readState).mockResolvedValue(EMPTY_STATE);
    vi.mocked(state.writeState).mockResolvedValue(undefined);
    vi.mocked(fetchers.fetchEnabledServices).mockResolvedValue(SOME_RESULTS);
    vi.mocked(alert.buildAlertBlocks).mockReturnValue([]);
    vi.mocked(alert.sendSlackAlert).mockResolvedValue(undefined);
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
  });

  it('stays silent and does not write state when the diff has no changes (FR-21)', async () => {
    vi.mocked(config.loadConfig).mockReturnValue({ slackWebhook: 'https://hooks.slack.example/x', enabledVendors: ['github'] });
    vi.mocked(diffModule.diff).mockReturnValue({ hasChanges: false, newIncidents: [], recovered: [] });

    await run();

    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('staying silent'));
    expect(alert.sendSlackAlert).not.toHaveBeenCalled();
    expect(state.writeState).not.toHaveBeenCalled();
  });

  it('sends the alert and writes the next state when the diff has changes', async () => {
    const diffResult: DiffResult = {
      hasChanges: true,
      newIncidents: [{ name: 'GitHub', status: 'major_outage', description: 'down', fetchedAt: '2026-07-01T12:00:00.000Z' }],
      recovered: [],
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
  });

  it('fails loudly and does NOT write state when the Slack send fails (FR-16, FR-26)', async () => {
    vi.mocked(config.loadConfig).mockReturnValue({ slackWebhook: 'https://hooks.slack.example/x', enabledVendors: ['github'] });
    vi.mocked(diffModule.diff).mockReturnValue({
      hasChanges: true,
      newIncidents: [{ name: 'GitHub', status: 'major_outage', description: 'down', fetchedAt: '2026-07-01T12:00:00.000Z' }],
      recovered: [],
    });
    vi.mocked(alert.sendSlackAlert).mockRejectedValue(new Error('Slack webhook responded with status 500'));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('500'));
    expect(diffModule.applyDiff).not.toHaveBeenCalled();
    expect(state.writeState).not.toHaveBeenCalled();
  });
});
