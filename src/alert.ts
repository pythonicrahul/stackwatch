import { DiffResult, ServiceStatus, StackState, isAlertable } from './types';

interface SlackBlock {
  type: string;
  text?: { type: 'mrkdwn' | 'plain_text'; text: string };
}

const SEVERITY_EMOJI: Partial<Record<ServiceStatus, string>> = {
  degraded_performance: '🟡',
  partial_outage: '🟠',
  major_outage: '🔴',
  unknown: '⚪',
};

const STATUS_LABEL: Record<ServiceStatus, string> = {
  operational: 'Operational',
  degraded_performance: 'Degraded Performance',
  partial_outage: 'Partial Outage',
  major_outage: 'Major Outage',
  maintenance: 'Under Maintenance',
  unknown: 'Unknown / Unreachable',
};

/** Formats the gap between two ISO timestamps as e.g. "2d 3h", "45m", "0m". */
function formatDuration(startIso: string, endIso: string): string {
  const ms = Math.max(0, new Date(endIso).getTime() - new Date(startIso).getTime());
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

/** Builds the batched Block Kit payload for a run's new incidents and
 * recoveries (FR-22 to FR-25). `previous` supplies each service's incident
 * anchor (`since`) for elapsed-time / downtime-duration text. */
export function buildAlertBlocks(diffResult: DiffResult, previous: StackState): SlackBlock[] {
  const now = new Date().toISOString();
  const blocks: SlackBlock[] = [];

  for (const incident of diffResult.newIncidents) {
    const prev = previous.services[incident.name];
    const since = prev && isAlertable(prev.status) ? prev.since : now;
    const emoji = SEVERITY_EMOJI[incident.status] ?? '⚪';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${incident.name}* — ${STATUS_LABEL[incident.status]}, since ${formatDuration(since, now)} ago\n${incident.description}`,
      },
    });
  }

  for (const recovery of diffResult.recovered) {
    const prev = previous.services[recovery.name];
    const since = prev?.since ?? now;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🟢 *${recovery.name}* — Recovered after ${formatDuration(since, now)} of downtime`,
      },
    });
  }

  return blocks;
}

/** Sends one batched Block Kit message (FR-25). Throws on non-2xx so the
 * caller can fail loudly (FR-26) and skip the state write (FR-16). Never
 * logs the webhook URL, even on failure (NFR-4). */
export async function sendSlackAlert(webhookUrl: string, blocks: SlackBlock[]): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook responded with status ${response.status}`);
  }
}
