# agentscan-logs

The scan half of [AgentScan](https://github.com/MatteoGabriele/agentscan): the
hourly GitHub scan, the data files it writes, and the Nitro endpoints that serve
them back to the app at `logs.agentscan.tools`.

The app repo keeps the site, the GitHub App, the webhook and the verified
automations list. Nothing in here renders anything.

## How an hour runs

1. A Netlify scheduled function ([`netlify/functions/trigger-hourly-scan.ts`](netlify/functions/trigger-hourly-scan.ts))
   fires at the top of every hour and dispatches the workflow. GitHub's own
   scheduler is too unreliable to drive this.
2. [`.github/workflows/scan-users-hourly.yml`](.github/workflows/scan-users-hourly.yml)
   runs [`scripts/scan-users.ts`](scripts/scan-users.ts), which reads every PR
   opened in the *previous full clock hour* across the tracked repos, scores each
   author with [`@unveil/identity`](https://github.com/unveil-project/identity),
   and rewrites the files in [`data/`](data).
3. The workflow commits those files to `main`. That push is what deploys the
   endpoints below — they read the data straight out of the bundle.
4. On the run that completes a day, the daily rollup changes and
   [`scripts/notify-discord.ts`](scripts/notify-discord.ts) posts the digest.

## Data files

| File | Written by | Retention |
| --- | --- | --- |
| `data/hourly-window-scan-results.txt` | every run | last 30 hourly buckets |
| `data/daily-scan-results.json` | the run that completes a day | never trimmed |
| `data/automation-ids.json` | every run | never trimmed, only grows |
| `data/hourly-scan-results.txt` | nothing — kept history | frozen |

`hourly-scan-results.txt` is left over from the pre-window scan. Nothing serves
it, and `nitro.config.ts` keeps it out of the server bundle.

## Endpoints

| Route | Reads | Used by |
| --- | --- | --- |
| `GET /api/health` | `daily-scan-results.json` | the health page (`?full=true` for all history, default is the last two months) |
| `GET /api/health/hourly-window` | `hourly-window-scan-results.txt` | the 25-hour chart |
| `GET /api/health/trmnl` | `daily-scan-results.json` | the TRMNL device plugin |
| `GET /api/automation-tally` | `automation-ids.json` | the automations page |

The app proxies all four at the same paths and does the caching, so there are no
route rules here.

## Environment

Copy `.env.example` to `.env` for local runs. On Netlify, the site needs
`PR_HASH_SECRET` (`/api/automation-tally` cannot decrypt account ids without it)
and `GITHUB_WORKFLOW_DISPATCH_TOKEN` (the scheduled function's dispatch token).
The workflow reads `NUXT_GITHUB_TOKEN_ANASTELLINE`, `PR_HASH_SECRET` and
`OSS_GUILD_DISCORD_WEBHOOK` from repository secrets.

## Commands

```sh
pnpm dev                 # nitro dev server
pnpm build               # tsc + vite build
pnpm test                # vitest
pnpm lint                # biome
pnpm scan:users:hourly   # run the scan locally against .env
pnpm trigger:discord:dry-run
```
