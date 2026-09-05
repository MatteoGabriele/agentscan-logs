# agentscan-logs

This is where the magic happens, maybe, and where [AgentScan](https://github.com/MatteoGabriele/agentscan)'s data collection actually lives.

![img](https://i.giphy.com/oWQzTz2A4fp1m.webp)

Nothing in here renders anything. This is just the hourly scan workflow and the API end-point.

## Repo liveness

`shared/daily-scan.ts` names the repos the hourly scan reads PRs from, and some
of them go quiet. `pnpm liveness` scores every one of them from 0 (dead) to 10
(very active) on PR volume, freshness and whether anyone is still merging, and
lists the ones worth dropping.

```sh
pnpm liveness                  # score every repo in the list, worst first
pnpm liveness --below=3        # only the ones on their way out
pnpm liveness --sort=best      # busiest first
pnpm liveness --repos=vuejs/core,nuxt/nuxt
pnpm liveness --lookback=90 --concurrency=6
pnpm liveness --json=data/repo-liveness.json
pnpm liveness --no-cache
```

Three REST calls per repo, each sent with the ETag from the previous run: a repo
that has not changed answers 304, which costs nothing against the rate limit. A
full pass over 400 repos takes ~3 minutes and ~1,100 calls cold, and a fraction
of that afterwards. The run stops on its own with 200 calls left so the hourly
scan keeps its budget. Scoring lives in `shared/utils/repo-liveness.ts`.
