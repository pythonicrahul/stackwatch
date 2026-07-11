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

concurrency:
  group: stackwatch
  cancel-in-progress: false

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
2. Add the workflow above to `.github/workflows/stackwatch.yml`. The
   `concurrency:` block matters more than it looks — without it, an
   unusually slow run (e.g. a vendor API hanging near its 5s timeout) could
   still be in flight when the next 5-minute cron fires, and both runs would
   read the same previous state and could independently alert on the same
   transition. `concurrency:` makes GitHub queue the next run instead of
   starting it in parallel.
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

### Outputs

Every run (other than "no `monitor_*` enabled") sets these, so a later step
in the same job can react without re-parsing logs:

| Name                  | Type    | Description                                             |
| --------------------- | ------- | --------------------------------------------------------|
| `has_incidents`       | boolean | `true` if any vendor is in a new alertable incident this run |
| `new_incident_count`  | number  | Count of new incidents alerted on this run               |
| `recovered_count`     | number  | Count of vendors that recovered this run                 |
| `alert_sent`          | boolean | `true` if a Slack message was sent and accepted this run  |

Every run also writes a per-vendor status table to the job's **Summary**
tab in the Actions UI — current status plus whether this run alerted or
recovered on it — so you can see the outcome at a glance without opening
logs, even on a totally silent, healthy run.

## How it works

Each run walks through one module per step — the labels below are the actual
source files, in call order:

```mermaid
flowchart TD
    A(["Cron schedule or workflow_dispatch"]) --> B["main.ts — entrypoint"]
    B --> C["run.ts — orchestration"]
    C --> D["config.ts\nread slack_webhook + monitor_* inputs"]
    D --> E{"Any monitor_* enabled?"}
    E -- No --> E1(["core.warning, exit\nno network calls, no Slack"])
    E -- Yes --> F["fetchers/*.ts\nfetch enabled vendors concurrently\n5s timeout, 1 retry each"]
    F --> G["state.ts: readState()\nrestore previous state from Actions cache"]
    G --> H["diff.ts: diff()\ncompare previous vs. current, per vendor"]
    H --> I{"hasChanges?"}
    I -- No --> I1(["exit silently\nno Slack message, no state write"])
    I -- Yes --> J["alert.ts: buildAlertBlocks()\nbatch new incidents + recoveries"]
    J --> K["alert.ts: sendSlackAlert()"]
    K --> L{"Slack accepted it?"}
    L -- No --> L1(["core.setFailed()\nstate NOT written — next run retries"])
    L -- Yes --> M["diff.ts: applyDiff()\ncompute next state"]
    M --> N["state.ts: writeState()\nsave to Actions cache under a fresh key"]
    N --> O(["Run complete"])
```

The trickiest part is the middle box — `diff.ts` classifies *each vendor
independently* by comparing its restored previous status against its
freshly-fetched current status:

```mermaid
flowchart TD
    S["Per vendor: previous status vs. current fetched status"] --> T{"Is current status alertable?\ndegraded / partial / major / unknown"}
    T -- No --> T1{"Was previous status alertable?"}
    T1 -- Yes --> T1a(["RECOVERED\nalert once, reset alertedAt to null"])
    T1 -- No --> T1b(["steady healthy / maintenance\ndo nothing"])
    T -- Yes --> U{"Was previous status also alertable?"}
    U -- No --> U1(["NEW INCIDENT\nalert, since = now"])
    U -- Yes --> V{"Was alertedAt already set?"}
    V -- Yes --> V1(["ONGOING, SILENCED\nno alert; since/alertedAt kept unchanged"])
    V -- No --> V2(["RETRY ALERT\nlast run's write must have failed"])
```

That `ONGOING, SILENCED` branch is why a vendor that's still down doesn't
re-alert every 5 minutes — and why `since` keeps pointing at when the
incident *actually* started even across many silent runs, so the eventual
recovery message reports the true total downtime.

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
