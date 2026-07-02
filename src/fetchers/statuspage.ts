import { fetchJsonWithRetry } from '../http';
import { ServiceStatus } from '../types';
import { Fetcher, withUnknownFallback } from './base';

interface StatuspageComponent {
  status: string;
}

interface StatuspageSummary {
  status: {
    indicator: string; // 'none' | 'minor' | 'major' | 'critical'
    description: string;
  };
  components?: StatuspageComponent[];
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
    default:
      return 'unknown';
  }
}

/** Shared adapter for every vendor built on Atlassian Statuspage (FR-9). The
 * page-level indicator doesn't reflect scheduled maintenance, so we fall back
 * to scanning components for `under_maintenance` when the indicator itself
 * reads as healthy. */
export function createStatuspageFetcher(name: string, summaryUrl: string): Fetcher {
  return withUnknownFallback(name, async () => {
    const summary = await fetchJsonWithRetry<StatuspageSummary>(summaryUrl);
    let status = normaliseIndicator(summary.status.indicator);
    if (status === 'operational' && summary.components?.some((c) => c.status === 'under_maintenance')) {
      status = 'maintenance';
    }
    return {
      name,
      status,
      description: summary.status.description,
      fetchedAt: new Date().toISOString(),
    };
  });
}
