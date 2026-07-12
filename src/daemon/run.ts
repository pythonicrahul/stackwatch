import { buildAlertBlocks, sendSlackAlert } from '../alert';
import { applyDiff, diff } from '../diff';
import { fetchEnabledServices } from '../fetchers';
import { DiffResult, ServiceResult, VendorId } from '../types';
import { DaemonConfig, Subscriber } from './config';
import { HealthTracker } from './health';
import { Logger } from './logger';
import { readDaemonState, writeDaemonState } from './state';

/** Narrows a global DiffResult down to just the vendors a given subscriber
 * cares about, recomputing `hasChanges` on the *filtered* result — this is
 * the actual mechanism that makes per-subscriber fan-out correct rather
 * than decorative. Getting this wrong (e.g. forgetting to recompute
 * hasChanges) would mean every subscriber gets a message on every global
 * change regardless of relevance. */
function filterDiffForSubscriber(diffResult: DiffResult, allowedNames: Set<string>): DiffResult {
  const newIncidents = diffResult.newIncidents.filter((r) => allowedNames.has(r.name));
  const recovered = diffResult.recovered.filter((r) => allowedNames.has(r.name));
  return { hasChanges: newIncidents.length > 0 || recovered.length > 0, newIncidents, recovered };
}

function allowedNamesFor(subscriber: Subscriber, resultByVendorId: Map<VendorId, ServiceResult>): Set<string> {
  const names = subscriber.vendors
    .map((id) => resultByVendorId.get(id)?.name)
    .filter((name): name is string => Boolean(name));
  return new Set(names);
}

export interface RunDaemonCycleDeps {
  config: DaemonConfig;
  logger: Logger;
  tracker: HealthTracker;
}

/** One poll-diff-alert-persist cycle, run on every `node-cron` tick (and
 * once immediately at startup). Fetches each *distinct* vendor across all
 * subscribers exactly once — the actual "poll once, fan out to many"
 * contract — diffs once against the single global state, then sends each
 * subscriber only the slice of that diff relevant to their own vendor list.
 *
 * State is global (one shared document, not one per subscriber), so if
 * *any* subscriber's send fails, the whole state write is skipped and every
 * subscriber retries next cycle — the alternative (writing state after a
 * partial failure) would mark the failed subscriber's incident as already
 * `alertedAt`, silently losing their retry chance, since alertedAt isn't
 * tracked per subscriber. Over-notifying the successful ones with a
 * harmless duplicate is the safer failure mode.
 *
 * Known limitation, documented rather than solved here (see README's
 * Roadmap): a subscriber added mid-incident won't see an already-ongoing,
 * already-alerted incident until it recovers, since there's no per-
 * (subscriber, vendor) "have I told this one yet" tracking.
 */
export async function runDaemonCycle({ config, logger, tracker }: RunDaemonCycleDeps): Promise<void> {
  tracker.recordPollStart();
  try {
    const distinctVendorIds = Array.from(new Set(config.subscribers.flatMap((s) => s.vendors)));
    const results = await fetchEnabledServices(distinctVendorIds);

    const resultByVendorId = new Map<VendorId, ServiceResult>();
    distinctVendorIds.forEach((id, index) => {
      const result = results[index];
      if (result) resultByVendorId.set(id, result);
    });

    const previous = readDaemonState(config.stateFilePath, logger);
    const diffResult = diff(previous, results);

    if (!diffResult.hasChanges) {
      logger.info('no state changes detected; staying silent');
      tracker.recordPollSuccess();
      return;
    }

    let anySendFailed = false;
    for (const subscriber of config.subscribers) {
      const subscriberDiff = filterDiffForSubscriber(diffResult, allowedNamesFor(subscriber, resultByVendorId));
      if (!subscriberDiff.hasChanges) continue;

      const blocks = buildAlertBlocks(subscriberDiff, previous);
      try {
        await sendSlackAlert(subscriber.slackWebhook, blocks);
        logger.info('sent alert', {
          subscriber: subscriber.name,
          newIncidents: subscriberDiff.newIncidents.length,
          recovered: subscriberDiff.recovered.length,
        });
      } catch (error) {
        anySendFailed = true;
        logger.error('failed to send Slack alert', { subscriber: subscriber.name, error: (error as Error).message });
      }
    }

    if (anySendFailed) {
      tracker.recordPollFailure('one or more subscriber sends failed; state not persisted, will retry next cycle');
      return;
    }

    const nextState = applyDiff(previous, results, diffResult);
    writeDaemonState(config.stateFilePath, nextState, logger);
    tracker.recordPollSuccess();
  } catch (error) {
    logger.error('poll cycle failed', { error: (error as Error).message });
    tracker.recordPollFailure((error as Error).message);
  }
}
