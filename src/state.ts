import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SCHEMA_VERSION, StackState } from './types';

const REPO_VARIABLE_NAME = 'STACKWATCH_STATE';
const CACHE_KEY = 'stackwatch-state-v1';
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

function repoApiBase(): string | null {
  const repo = process.env.GITHUB_REPOSITORY;
  return repo ? `https://api.github.com/repos/${repo}` : null;
}

/** GITHUB_TOKEN is not injected automatically — the consumer workflow must
 * pass it explicitly (`env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`)
 * alongside `permissions: actions: write` (Assumption A-2). Its absence is
 * not an error here; it just means this layer is unavailable and callers
 * fall back to the cache layer. */
function authHeaders(): Record<string, string> | null {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function readRepoVariable(): Promise<StackState | null> {
  const base = repoApiBase();
  const headers = authHeaders();
  if (!base || !headers) return null;

  const response = await fetch(`${base}/actions/variables/${REPO_VARIABLE_NAME}`, { headers });
  if (response.status === 404) return emptyState();
  if (!response.ok) {
    throw new Error(`repo variable read failed with status ${response.status}`);
  }
  const body = (await response.json()) as { value: string };
  return parseState(body.value) ?? emptyState();
}

async function writeRepoVariable(state: StackState): Promise<void> {
  const base = repoApiBase();
  const headers = authHeaders();
  if (!base || !headers) {
    throw new Error('repo variable write skipped: missing GITHUB_REPOSITORY or GITHUB_TOKEN');
  }
  const value = JSON.stringify(state);

  const patchResponse = await fetch(`${base}/actions/variables/${REPO_VARIABLE_NAME}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: REPO_VARIABLE_NAME, value }),
  });
  if (patchResponse.ok) return;
  if (patchResponse.status !== 404) {
    throw new Error(`repo variable update failed with status ${patchResponse.status}`);
  }

  const createResponse = await fetch(`${base}/actions/variables`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: REPO_VARIABLE_NAME, value }),
  });
  if (!createResponse.ok) {
    throw new Error(`repo variable create failed with status ${createResponse.status}`);
  }
}

function tempStateFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackwatch-'));
  return path.join(dir, CACHE_STATE_FILE);
}

async function readCacheState(): Promise<StackState> {
  const filePath = tempStateFilePath();
  const hitKey = await cache.restoreCache([filePath], CACHE_KEY);
  if (!hitKey || !fs.existsSync(filePath)) return emptyState();
  return parseState(fs.readFileSync(filePath, 'utf8')) ?? emptyState();
}

async function writeCacheState(state: StackState): Promise<void> {
  const filePath = tempStateFilePath();
  fs.writeFileSync(filePath, JSON.stringify(state));
  // NOTE: Actions cache keys are immutable once saved — a fixed key can only
  // be written once per scope. This makes the cache layer a genuine
  // best-effort fallback, not a reliable long-term store; the repo variable
  // layer is the one that should be relied on for continuous operation.
  await cache.saveCache([filePath], CACHE_KEY);
}

/** Reads previous state: repo variable is primary (FR-12), Actions cache is
 * the fallback (FR-13). Returns a fresh empty state on first run at either
 * layer, or when neither layer is reachable (FR-14). */
export async function readState(): Promise<StackState> {
  try {
    const state = await readRepoVariable();
    if (state) return state;
  } catch (error) {
    core.warning(`stackwatch: repo variable state read failed, falling back to cache: ${(error as Error).message}`);
  }
  try {
    return await readCacheState();
  } catch (error) {
    core.warning(`stackwatch: cache state read also failed, treating as first run: ${(error as Error).message}`);
    return emptyState();
  }
}

/** Persists state: repo variable primary, Actions cache fallback. Callers
 * MUST only invoke this after alerts have been sent successfully (FR-16). */
export async function writeState(state: StackState): Promise<void> {
  try {
    await writeRepoVariable(state);
    return;
  } catch (error) {
    core.warning(`stackwatch: repo variable state write failed, falling back to cache: ${(error as Error).message}`);
  }
  try {
    await writeCacheState(state);
  } catch (error) {
    core.warning(`stackwatch: cache state write also failed; next run will not see this update: ${(error as Error).message}`);
  }
}
