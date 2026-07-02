export type ServiceStatus =
  | 'operational'
  | 'degraded_performance'
  | 'partial_outage'
  | 'major_outage'
  | 'maintenance'
  | 'unknown';

/** Statuses that represent an active, alertable incident. `maintenance` is
 * intentionally excluded — scheduled maintenance MUST NOT page anyone (P-1). */
export const ALERTABLE_STATUSES: readonly ServiceStatus[] = [
  'degraded_performance',
  'partial_outage',
  'major_outage',
  'unknown',
];

export function isAlertable(status: ServiceStatus): boolean {
  return ALERTABLE_STATUSES.includes(status);
}

export interface ServiceResult {
  name: string;
  status: ServiceStatus;
  description: string;
  fetchedAt: string; // ISO 8601
}

export interface PersistedServiceState {
  status: ServiceStatus;
  since: string; // ISO 8601 — when this status was first seen
  alertedAt: string | null; // null = incident not yet alerted
}

export const SCHEMA_VERSION = 1 as const;

export interface StackState {
  schemaVersion: typeof SCHEMA_VERSION;
  updatedAt: string; // ISO 8601
  services: Record<string, PersistedServiceState>;
}

export interface DiffResult {
  hasChanges: boolean;
  newIncidents: ServiceResult[];
  recovered: ServiceResult[];
}

/** Vendor identifiers supported in this MVP release. */
export type VendorId = 'github' | 'datadog' | 'clickhouse' | 'claude';
