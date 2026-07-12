import { describe, expect, it } from 'vitest';
import { isValidSlackWebhook } from './validation';

describe('isValidSlackWebhook', () => {
  it('accepts a well-formed Slack incoming webhook URL', () => {
    expect(isValidSlackWebhook('https://hooks.slack.com/services/T000/B000/xxxxxxxxxxxxxxxxxxxxxxxx')).toBe(true);
  });

  it.each(['https://example.com/not-a-webhook', 'http://hooks.slack.com/services/T000/B000/xxx', '', 'not a url'])(
    'rejects %s',
    (candidate) => {
      expect(isValidSlackWebhook(candidate)).toBe(false);
    }
  );
});
