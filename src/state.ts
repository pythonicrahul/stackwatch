import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SCHEMA_VERSION, StackState } from './types';

const CACHE_KEY_PREFIX = 'stackwatch-state-v1';
const CACHE_STATE_FILE = 'stackwatch-state.json';

function emptyState(): StackState {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), services: {} };
}

/** Parses stored state, discarding it on schema mismatch or corruption (FR-15). */
function parseState(raw: string): StackState | null {
  try {
    const parsed = JSON.parse(raw) as StackState;
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      core.warning(
        `stackwatch: state schemaVersion mismatch (found ${String(parsed.schemaVersion)}, expected ${SCHEMA_VERSION}); reinitialising.`
      );
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** MUST be a fixed path, not a freshly-generated one (e.g. via
 * `mkdtempSync`). `@actions/cache`'s restore extracts files to the exact
 * absolute path recorded at save time (GNU tar with `-P`), not to whatever
 * path is passed into `restoreCache` for a later call — so the save-time and
 * restore-time paths must be identical across separate runs for the cache
 * fallback to ever actually round-trip anything. */
function cacheStateFilePath(): string {
  return path.join(os.tmpdir(), CACHE_STATE_FILE);
}

/** State is stored entirely in GitHub Actions cache — no GitHub API token is
 * required. The Actions REST API for repo variables/secrets is deliberately
 * off-limits to the automatic per-run `GITHUB_TOKEN` regardless of the
 * `permissions:` block (confirmed via real testing: a 403 on that endpoint
 * even with `actions: write` granted), so a repo-variable-backed primary
 * layer would only ever work for consumers willing to supply a personal
 * access token — real friction this design avoids entirely.
 *
 * Cache keys are immutable once saved — reusing a fixed key on a second
 * write fails with "unable to reserve cache" (confirmed in E2E testing: the
 * write silently no-ops instead of throwing). Without a mutable key, every
 * run after the first state change would keep restoring the *same* stale
 * entry forever and re-alert on it every time, breaking the no-repeat-alert
 * guarantee (P-3/G-3) outright. So `writeState` uses a fresh, unique key per
 * write, and `readState` uses `restoreKeys` prefix matching to fetch
 * whichever one was saved most recently; older entries just age out via the
 * platform's normal 7-day cache eviction. */
export async function readState(): Promise<StackState> {
  try {
    const filePath = cacheStateFilePath();
    const hitKey = await cache.restoreCache([filePath], `${CACHE_KEY_PREFIX}-none`, [CACHE_KEY_PREFIX]);
    if (!hitKey || !fs.existsSync(filePath)) return emptyState();
    return parseState(fs.readFileSync(filePath, 'utf8')) ?? emptyState();
  } catch (error) {
    core.warning(`stackwatch: cache state read failed, treating as first run: ${(error as Error).message}`);
    return emptyState();
  }
}

/** Callers MUST only invoke this after alerts have been sent successfully
 * (FR-16). Failures here are logged, not thrown — a missed state write just
 * means the next run retries from the same previous state. */
export async function writeState(state: StackState): Promise<void> {
  try {
    const filePath = cacheStateFilePath();
    fs.writeFileSync(filePath, JSON.stringify(state));
    await cache.saveCache([filePath], `${CACHE_KEY_PREFIX}-${crypto.randomUUID()}`);
  } catch (error) {
    core.warning(`stackwatch: cache state write failed; next run will not see this update: ${(error as Error).message}`);
  }
}
