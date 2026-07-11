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

permissions:
  actions: write   # required so stackwatch can persist state in a repo variable

jobs:
  check:
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
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
3. Grant `permissions: actions: write` (shown above).
4. Pass a token through as the step/job `GITHUB_TOKEN` env var, exactly as
   shown above — GitHub does **not** inject one into an action's process
   automatically.

   **Important:** the default `${{ secrets.GITHUB_TOKEN }}` will **not**
   actually give you the repo-variable state layer. GitHub's automatic
   per-run token cannot manage Actions variables/secrets via the REST API —
   this is a hard platform restriction (to stop a workflow from
   self-escalating by rewriting its own secrets), not a permissions
   misconfiguration, and no `permissions:` block can grant it. Every
   consumer using the default token will get a `403` on the repo-variable
   read/write and silently fall back to the Actions cache layer instead.
   That fallback is confirmed working end-to-end (including correctly
   suppressing repeat alerts across runs) — it's a genuine fallback, not
   just a stopgap — but the repo-variable layer is still the one to prefer
   when you can, since Actions cache entries are subject to the platform's
   normal 7-day/10GB-per-repo eviction.

   To actually get the reliable repo-variable layer, create a
   [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
   scoped to just this repo with the **Variables: Read and write**
   repository permission, save it as a secret (e.g. `STACKWATCH_PAT`), and
   pass *that* as `GITHUB_TOKEN` in the workflow instead of
   `secrets.GITHUB_TOKEN`.
5. Enable whichever `monitor_*` inputs you want — every vendor defaults to
   `false` (opt-in only).

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
concurrently (5s timeout, one retry each) → read previous state (repo
variable, falling back to Actions cache) → diff against current results →
if anything changed, send one batched Slack message and persist the new
state. If nothing changed, or if the Slack send fails, no state is written,
so the next run picks up exactly where this one left off.

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
