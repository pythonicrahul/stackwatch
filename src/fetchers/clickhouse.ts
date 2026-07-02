import { fetchJsonWithRetry } from '../http';
import { ServiceStatus } from '../types';
import { Fetcher, withUnknownFallback } from './base';

const CLICKHOUSE_STATUS_URL = 'https://status.clickhouse.com/api/v2/summary.json';
const SERVICE_NAME = 'ClickHouse Cloud';

interface ClickHouseSummary {
  status: {
    indicator: string;
    description: string;
  };
}

function normaliseIndicator(indicator: string): ServiceStatus {
  switch (indicator) {
    case 'none':
      return 'operational';
    case 'minor':
      return 'degraded_performance';
    case 'major':
      return 'partial_outage';
    case 'critical':
      return 'major_outage';
    case 'maintenance':
      return 'maintenance';
    default:
      return 'unknown';
  }
}

/** ClickHouse Cloud is not on Atlassian Statuspage (it's incident.io-based)
 * and has no `incidents` array, so per FR-10 it gets its own dedicated
 * adapter rather than reusing StatuspageFetcher. */
export function createClickHouseFetcher(): Fetcher {
  return withUnknownFallback(SERVICE_NAME, async () => {
    const summary = await fetchJsonWithRetry<ClickHouseSummary>(CLICKHOUSE_STATUS_URL);
    return {
      name: SERVICE_NAME,
      status: normaliseIndicator(summary.status.indicator),
      description: summary.status.description,
      fetchedAt: new Date().toISOString(),
    };
  });
}
