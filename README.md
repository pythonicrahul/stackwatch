# stackwatch

A GitHub Action that watches the public status pages of the third-party
developer tools your team depends on, and posts a Slack alert the moment one
degrades, recovers, or becomes unreachable. Silent when everything is
healthy; fires once per incident, not once per run.

See [`PRD.md`](./PRD.md) for the full product requirements.

## MVP vendor support

This release supports 4 commonly-used vendors:

| Vendor      | Status page              |
| ----------- | ------------------------- |
| GitHub      | githubstatus.com          |
| Datadog     | status.datadoghq.com      |
| ClickHouse Cloud | status.clickhouse.com |
| Claude / Anthropic | status.claude.com  |

More vendors (Slack, AWS, Vercel, PagerDuty, Linear, ...) can be added later
without restructuring — see [Adding a vendor](#adding-a-vendor).

## Usage

```yaml
name: stackwatch
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: yourusername/stackwatch@v1
        with:
          slack_webhook: ${{ secrets.STACKWATCH_SLACK_WEBHOOK }}
          monitor_github: true
          monitor_datadog: true
          monitor_clickhouse: true
          monitor_claude: true
```

### Setup

1. Create a [Slack incoming webhook](https://api.slack.com/messaging/webhooks)
   for the channel you want alerts in, and save it as a repository secret
   named `STACKWATCH_SLACK_WEBHOOK`.
2. Add the workflow above to `.github/workflows/stackwatch.yml`.
3. Enable whichever `monitor_*` inputs you want — every vendor defaults to
   `false` (opt-in only).

That's it — no `permissions:` block, no GitHub token, no PAT. State (which
services were already alerted on) is stored entirely in GitHub Actions
cache, which every workflow gets for free. An earlier version of this
action tried to use a repo variable for that instead, authenticated with
the workflow's own `GITHUB_TOKEN` — but GitHub deliberately blocks the
automatic per-run token from managing Actions variables/secrets via the
REST API (confirmed via real testing: a `403` even with `actions: write`
granted, to stop a workflow from self-escalating by rewriting its own
secrets). Making that work would have required every consumer to create
and maintain a personal access token just for this — real friction for
little benefit, since the cache-only design is confirmed reliable
end-to-end (including correctly suppressing repeat alerts across runs).
The one tradeoff: Actions cache entries are subject to the platform's
normal 7-day-unused eviction, which in practice a 5-minute cron never hits.

Inputs you don't set stay disabled and are never fetched.

### Inputs

| Name                 | Type    | Required | Default | Description                     |
| -------------------- | ------- | -------- | ------- | -------------------------------- |
| `slack_webhook`      | string  | Yes      | —       | Slack incoming webhook URL       |
| `monitor_github`     | boolean | No       | `false` | Monitor GitHub status            |
| `monitor_datadog`    | boolean | No       | `false` | Monitor Datadog status           |
| `monitor_clickhouse` | boolean | No       | `false` | Monitor ClickHouse Cloud status  |
| `monitor_claude`     | boolean | No       | `false` | Monitor Claude / Anthropic status|

## How it works

On each run: read inputs → fetch all enabled vendors' status APIs
concurrently (5s timeout, one retry each) → read previous state from
GitHub Actions cache → diff against current results → if anything changed,
send one batched Slack message and persist the new state. If nothing
changed, or if the Slack send fails, no state is written, so the next run
picks up exactly where this one left off.

## Adding a vendor

1. If the vendor runs on Atlassian Statuspage (`/api/v2/summary.json`), add
   one line to `src/fetchers/index.ts` calling
   `createStatuspageFetcher(name, url)`. Otherwise write a dedicated adapter
   under `src/fetchers/` following `clickhouse.ts` as a template.
2. Register the vendor in `VendorId` (`src/types.ts`), `VENDOR_INPUTS`
   (`src/config.ts`), and as a new `monitor_*` input in `action.yml`.
3. Run `npm run package` to rebuild `dist/index.js`.

## Development

```bash
npm install
npm run typecheck
npm test           # vitest — unit tests for every module, mocking network/@actions/cache
npm run build      # produces dist/index.js via @vercel/ncc
npm run package    # typecheck + test + build, in that order
```

Tests are colocated as `src/**/*.test.ts` and never bundled into `dist/index.js`
(`ncc` only follows `main.ts`'s own runtime imports). `dist/index.js` is
committed and rebuilt automatically by `.github/workflows/release.yml` on
every push to `main`; don't hand-edit it.
