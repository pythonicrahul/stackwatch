import { describe, expect, it } from 'vitest';
import { isAlertable, ServiceStatus } from './types';

describe('isAlertable', () => {
  const alertable: ServiceStatus[] = ['degraded_performance', 'partial_outage', 'major_outage', 'unknown'];
  const notAlertable: ServiceStatus[] = ['operational', 'maintenance'];

  it.each(alertable)('treats %s as alertable', (status) => {
    expect(isAlertable(status)).toBe(true);
  });

  it.each(notAlertable)('does not treat %s as alertable', (status) => {
    expect(isAlertable(status)).toBe(false);
  });
});
