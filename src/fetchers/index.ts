import { ServiceResult, VendorId } from '../types';
import { Fetcher } from './base';
import { createClickHouseFetcher } from './clickhouse';
import { createStatuspageFetcher } from './statuspage';

const GITHUB_STATUS_URL = 'https://www.githubstatus.com/api/v2/summary.json';
const DATADOG_STATUS_URL = 'https://status.datadoghq.com/api/v2/summary.json';
const CLAUDE_STATUS_URL = 'https://status.claude.com/api/v2/summary.json';

/** Registry of all supported vendors. Adding a new vendor is: write an
 * adapter (or reuse createStatuspageFetcher), register it here, and add the
 * corresponding `monitor_*` input to action.yml + config.ts. */
const FETCHERS: Record<VendorId, Fetcher> = {
  github: createStatuspageFetcher('GitHub', GITHUB_STATUS_URL),
  datadog: createStatuspageFetcher('Datadog', DATADOG_STATUS_URL),
  claude: createStatuspageFetcher('Claude', CLAUDE_STATUS_URL),
  clickhouse: createClickHouseFetcher(),
};

/** Fetches only the enabled vendors concurrently (FR-5, FR-6). Each fetcher
 * already catches its own errors into an `unknown` result, so
 * Promise.allSettled here is defense-in-depth against an adapter that throws
 * outside its own try/catch. */
export async function fetchEnabledServices(enabled: VendorId[]): Promise<ServiceResult[]> {
  const settled = await Promise.allSettled(enabled.map((vendor) => FETCHERS[vendor]()));

  return settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      return outcome.value;
    }
    const vendor = enabled[index] as VendorId;
    const unknownResult: ServiceResult = {
      name: vendor,
      status: 'unknown',
      description: 'Fetcher threw unexpectedly.',
      fetchedAt: new Date().toISOString(),
    };
    return unknownResult;
  });
}
