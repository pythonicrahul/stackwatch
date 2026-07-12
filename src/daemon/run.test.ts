import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as alert from '../alert';
import * as diffModule from '../diff';
import * as fetchers from '../fetchers';
import { DiffResult, SCHEMA_VERSION, ServiceResult, StackState } from '../types';
import { DaemonConfig, Subscriber } from './config';
import { HealthTracker } from './health';
import { Logger } from './logger';
import { runDaemonCycle } from './run';
import * as state from './state';

vi.mock('../alert');
vi.mock('../diff');
vi.mock('../fetchers');
vi.mock('./state');

const NOW_ISO = '2026-07-01T12:00:00.000Z';
const EMPTY_STATE: StackState = { schemaVersion: SCHEMA_VERSION, updatedAt: NOW_ISO, services: {} };

function subscriber(overrides: Partial<Subscriber> = {}): Subscriber {
  return { name: 'default', slackWebhook: 'https://hooks.slack.com/services/T/B/x', vendors: ['github'], ...overrides };
}

function config(subscribers: Subscriber[]): DaemonConfig {
  return { subscribers, cronExpression: '*/5 * * * *', stateFilePath: '/data/state.json', healthPort: 8080 };
}

function result(name: string, status: ServiceResult['status'] = 'operational'): ServiceResult {
  return { name, status, description: 'd', fetchedAt: NOW_ISO };
}

function fakeLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function fakeTracker(): HealthTracker & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    recordPollStart: () => calls.push('start'),
    recordPollSuccess: () => calls.push('success'),
    recordPollFailure: (error) => calls.push(`failure:${error}`),
    getStatus: () => ({ healthy: true, state: 'healthy', startedAt: NOW_ISO, lastPollAt: NOW_ISO, lastSuccessAt: NOW_ISO, lastError: null }),
  };
}

describe('runDaemonCycle', () => {
  beforeEach(() => {
    vi.mocked(state.readDaemonState).mockReturnValue(EMPTY_STATE);
    vi.mocked(state.writeDaemonState).mockReturnValue(undefined);
    vi.mocked(alert.buildAlertBlocks).mockReturnValue([]);
    vi.mocked(alert.sendSlackAlert).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches each distinct vendor exactly once, even with overlapping subscribers watching the same vendor (the actual "poll once" contract)', async () => {
    const subscribers = [
      subscriber({ name: 'team-a', vendors: ['github', 'datadog'] }),
      subscriber({ name: 'team-b', vendors: ['github', 'clickhouse'] }),
    ];
    vi.mocked(fetchers.fetchEnabledServices).mockResolvedValue([]);
    vi.mocked(diffModule.diff).mockReturnValue({ hasChanges: false, newIncidents: [], recovered: [] });

    await runDaemonCycle({ config: config(subscribers), logger: fakeLogger(), tracker: fakeTracker() });

    expect(fetchers.fetchEnabledServices).toHaveBeenCalledTimes(1);
    const [calledWith] = vi.mocked(fetchers.fetchEnabledServices).mock.calls[0] as [string[]];
    expect(calledWith.sort()).toEqual(['clickhouse', 'datadog', 'github']); // deduped union, github once
  });

  it('stays silent and does not write state when the global diff has no changes', async () => {
    vi.mocked(fetchers.fetchEnabledServices).mockResolvedValue([result('GitHub')]);
    vi.mocked(diffModule.diff).mockReturnValue({ hasChanges: false, newIncidents: [], recovered: [] });
    const tracker = fakeTracker();

    await runDaemonCycle({ config: config([subscriber()]), logger: fakeLogger(), tracker });

    expect(alert.sendSlackAlert).not.toHaveBeenCalled();
    expect(state.writeDaemonState).not.toHaveBeenCalled();
    expect(tracker.calls).toEqual(['start', 'success']);
  });

  it('sends a subscriber only the incidents/recoveries for vendors they actually watch, not vendors only another subscriber watches', async () => {
    const subscribers = [
      subscriber({ name: 'team-a', slackWebhook: 'https://hooks.slack.com/services/T/A/x', vendors: ['github'] }),
      subscriber({ name: 'team-b', slackWebhook: 'https://hooks.slack.com/services/T/B/x', vendors: ['datadog'] }),
    ];
    vi.mocked(fetchers.fetchEnabledServices).mockResolvedValue([result('GitHub', 'major_outage'), result('Datadog')]);
    const globalDiff: DiffResult = {
      hasChanges: true,
      newIncidents: [{ name: 'GitHub', status: 'major_outage', description: 'down', fetchedAt: NOW_ISO }],
      recovered: [],
    };
    vi.mocked(diffModule.diff).mockReturnValue(globalDiff);
    vi.mocked(diffModule.applyDiff).mockReturnValue(EMPTY_STATE);

    await runDaemonCycle({ config: config(subscribers), logger: fakeLogger(), tracker: fakeTracker() });

    // Only team-a (watches github) gets sent to; team-b (datadog only) does not.
    expect(alert.sendSlackAlert).toHaveBeenCalledTimes(1);
    expect(alert.sendSlackAlert).toHaveBeenCalledWith('https://hooks.slack.com/services/T/A/x', expect.anything());
  });

  it('does not call sendSlackAlert for a subscriber whose filtered diff has no changes, even though the global diff did', async () => {
    // Two subscribers so github is actually fetched/diffed at all (a lone
    // datadog-only subscriber would never cause github to be fetched in the
    // first place) — team-b watches only datadog, so a github-only incident
    // must not reach them.
    const subscribers = [
      subscriber({ name: 'team-a', slackWebhook: 'https://hooks.slack.com/services/T/A/x', vendors: ['github'] }),
      subscriber({ name: 'team-b', slackWebhook: 'https://hooks.slack.com/services/T/B/x', vendors: ['datadog'] }),
    ];
    vi.mocked(fetchers.fetchEnabledServices).mockResolvedValue([result('GitHub', 'major_outage'), result('Datadog')]);
    vi.mocked(diffModule.diff).mockReturnValue({
      hasChanges: true,
      newIncidents: [{ name: 'GitHub', status: 'major_outage', description: 'down', fetchedAt: NOW_ISO }],
      recovered: [],
    });
    vi.mocked(diffModule.applyDiff).mockReturnValue(EMPTY_STATE);

    await runDaemonCycle({ config: config(subscribers), logger: fakeLogger(), tracker: fakeTracker() });

    expect(alert.sendSlackAlert).toHaveBeenCalledTimes(1);
    expect(alert.sendSlackAlert).not.toHaveBeenCalledWith('https://hooks.slack.com/services/T/B/x', expect.anything());
    expect(state.writeDaemonState).toHaveBeenCalled();
  });

  it('writes state once, after all subscriber sends succeed', async () => {
    vi.mocked(fetchers.fetchEnabledServices).mockResolvedValue([result('GitHub', 'major_outage')]);
    vi.mocked(diffModule.diff).mockReturnValue({
      hasChanges: true,
      newIncidents: [{ name: 'GitHub', status: 'major_outage', description: 'down', fetchedAt: NOW_ISO }],
      recovered: [],
    });
    vi.mocked(diffModule.applyDiff).mockReturnValue(EMPTY_STATE);
    const tracker = fakeTracker();

    await runDaemonCycle({ config: config([subscriber()]), logger: fakeLogger(), tracker });

    expect(state.writeDaemonState).toHaveBeenCalledTimes(1);
    expect(state.writeDaemonState).toHaveBeenCalledWith('/data/state.json', EMPTY_STATE, expect.anything());
    expect(tracker.calls).toEqual(['start', 'success']);
  });

  it('does NOT write state at all if any subscriber send fails, even if others succeeded (state is global, not per-subscriber)', async () => {
    const subscribers = [
      subscriber({ name: 'team-a', slackWebhook: 'https://hooks.slack.com/services/T/A/x', vendors: ['github'] }),
      subscriber({ name: 'team-b', slackWebhook: 'https://hooks.slack.com/services/T/B/x', vendors: ['datadog'] }),
    ];
    vi.mocked(fetchers.fetchEnabledServices).mockResolvedValue([result('GitHub', 'major_outage'), result('Datadog', 'major_outage')]);
    vi.mocked(diffModule.diff).mockReturnValue({
      hasChanges: true,
      newIncidents: [
        { name: 'GitHub', status: 'major_outage', description: 'down', fetchedAt: NOW_ISO },
        { name: 'Datadog', status: 'major_outage', description: 'down', fetchedAt: NOW_ISO },
      ],
      recovered: [],
    });
    vi.mocked(alert.sendSlackAlert)
      .mockResolvedValueOnce(undefined) // team-a succeeds
      .mockRejectedValueOnce(new Error('Slack webhook responded with status 500')); // team-b fails
    const tracker = fakeTracker();

    await runDaemonCycle({ config: config(subscribers), logger: fakeLogger(), tracker });

    expect(alert.sendSlackAlert).toHaveBeenCalledTimes(2);
    expect(state.writeDaemonState).not.toHaveBeenCalled();
    expect(tracker.calls).toEqual(['start', 'failure:one or more subscriber sends failed; state not persisted, will retry next cycle']);
  });

  it('catches an unexpected thrown error mid-cycle, logs it, and records a tracker failure rather than throwing', async () => {
    vi.mocked(fetchers.fetchEnabledServices).mockRejectedValue(new Error('boom'));
    const tracker = fakeTracker();

    await expect(runDaemonCycle({ config: config([subscriber()]), logger: fakeLogger(), tracker })).resolves.toBeUndefined();

    expect(tracker.calls).toEqual(['start', 'failure:boom']);
  });
});
