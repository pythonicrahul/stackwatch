/** Slack incoming webhooks are always issued under this exact host+path
 * shape (https://api.slack.com/messaging/webhooks), regardless of
 * workspace. Checking it up front means a typo'd secret fails immediately
 * with a clear message, instead of after fetching every enabled vendor, on
 * a generic network error from the eventual POST in alert.ts. Shared by the
 * Action's config.ts and the daemon's config.ts so the rule lives in one
 * place. */
const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/\S+$/;

export function isValidSlackWebhook(url: string): boolean {
  return SLACK_WEBHOOK_PATTERN.test(url);
}
