/// <reference types="node" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Octokit } from "octokit";
import { libraries } from "../shared/daily-scan";
import type {
	PrSample,
	RepoActivity,
	RepoLiveness,
} from "../shared/utils/repo-liveness";
import {
	LOOKBACK_DAYS,
	scoreRepoLiveness,
} from "../shared/utils/repo-liveness";

/**
 * Rates every repository the scan pulls PRs from on a 0–10 liveness scale, so
 * dead or drifting entries can be dropped from `shared/daily-scan.ts` before
 * they waste an hourly run's API budget.
 *
 * Three REST calls per repo, on the same endpoints the hourly scan uses. Each
 * one is sent with the ETag from the previous run, and GitHub answers an
 * unchanged repo with a 304 that costs nothing against the rate limit — so a
 * second run only pays for the repos that actually moved, which is never the
 * dead ones this is looking for.
 *
 * Usage:
 *   pnpm liveness
 *   pnpm liveness --below=3
 *   pnpm liveness --repos=vuejs/core,nuxt/nuxt --sort=best
 *   pnpm liveness --lookback=90 --concurrency=6
 *   pnpm liveness --json=data/repo-liveness.json
 *   pnpm liveness --no-cache
 */

const PRS_PER_PAGE = 100;
const CONCURRENT_REPOS = 5;
const RETRY_DELAY_MS = 2000;
const RETRY_MAX_ATTEMPT = 2;
const CACHE_FILE = ".cache/repo-liveness.json";
/** Leave this much of the hourly budget for the scan that actually matters. */
const RATE_LIMIT_FLOOR = 200;

interface Options {
	repos: string[];
	lookbackDays: number;
	concurrency: number;
	sort: "best" | "worst";
	below?: number;
	jsonFile?: string;
	cacheFile?: string;
}

/** What a run keeps per request: the ETag, plus the few fields scoring reads. */
interface CacheEntry<T> {
	etag: string;
	data: T;
}

interface RepoMeta {
	archived: boolean;
	disabled: boolean;
	pushed_at: string | null;
	stars: number;
}

type Cache = Record<string, CacheEntry<unknown> | undefined>;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(error: unknown) {
	return (error as { status?: number })?.status;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPT + 1; attempt++) {
		try {
			return await fn();
		} catch (error) {
			// 304 is the answer we hoped for and 404 is final: neither is worth a retry.
			const status = statusOf(error);
			if (status === 304 || status === 404 || status === 451) {
				throw error;
			}
			lastError = error;
			if (attempt <= RETRY_MAX_ATTEMPT) {
				console.error(`  ${label} failed, retrying...`);
				await sleep(RETRY_DELAY_MS);
			}
		}
	}
	throw lastError;
}

/**
 * Wraps Octokit with the two things this script needs on top of it: conditional
 * requests against the stored ETags, and a running view of the rate limit.
 */
function createFetcher(octokit: Octokit, cache: Cache) {
	let rateRemaining = Number.POSITIVE_INFINITY;
	let rateReset: Date | null = null;

	function track(headers: Record<string, unknown>) {
		const remaining = Number(headers["x-ratelimit-remaining"]);
		if (headers["x-ratelimit-remaining"] != null && !Number.isNaN(remaining)) {
			rateRemaining = remaining;
		}
		const reset = Number(headers["x-ratelimit-reset"]);
		if (!Number.isNaN(reset) && reset > 0) {
			rateReset = new Date(reset * 1000);
		}
	}

	/**
	 * Sends one request carrying the ETag from last time. A 304 costs nothing
	 * against the rate limit and is proof the stored payload is still current,
	 * so it is returned as is.
	 */
	async function conditional<Raw, T>(
		key: string,
		request: (headers: Record<string, string>) => Promise<{
			headers: Record<string, unknown>;
			data: Raw;
		}>,
		distill: (data: Raw) => T,
	): Promise<T> {
		const cached = cache[key] as CacheEntry<T> | undefined;
		const headers: Record<string, string> = cached?.etag
			? { "if-none-match": cached.etag }
			: {};

		try {
			const response = await withRetry(() => request(headers), key);
			track(response.headers);

			const distilled = distill(response.data);
			// Octokit sends the ETag back verbatim, weak prefix and all.
			const etag = String(response.headers.etag ?? "");
			if (etag) {
				cache[key] = { etag, data: distilled };
			}
			return distilled;
		} catch (error) {
			if (statusOf(error) === 304 && cached) {
				track(
					(error as { response?: { headers?: Record<string, unknown> } })
						.response?.headers ?? {},
				);
				return cached.data;
			}
			throw error;
		}
	}

	return {
		octokit,
		conditional,
		get remaining() {
			return rateRemaining;
		},
		get reset() {
			return rateReset;
		},
	};
}

type Fetcher = ReturnType<typeof createFetcher>;

async function fetchActivity(
	fetcher: Fetcher,
	repo: string,
): Promise<RepoActivity> {
	const [owner, name] = repo.split("/");
	const { octokit } = fetcher;

	const meta = await fetcher.conditional<
		Awaited<ReturnType<Octokit["rest"]["repos"]["get"]>>["data"],
		RepoMeta
	>(
		`${repo}:meta`,
		(headers) => octokit.rest.repos.get({ owner, repo: name, headers }),
		(data) => ({
			archived: data.archived,
			disabled: !!data.disabled,
			pushed_at: data.pushed_at ?? null,
			stars: data.stargazers_count,
		}),
	);

	// Newest PRs first: how much is being opened, and how recently.
	const createdPrs = await fetcher.conditional<
		Awaited<ReturnType<Octokit["rest"]["pulls"]["list"]>>["data"],
		PrSample[]
	>(
		`${repo}:created`,
		(headers) =>
			octokit.rest.pulls.list({
				owner,
				repo: name,
				state: "all",
				sort: "created",
				direction: "desc",
				per_page: PRS_PER_PAGE,
				headers,
			}),
		(data) =>
			data.map((pr) => ({
				createdAt: pr.created_at,
				mergedAt: pr.merged_at ?? null,
				closedAt: pr.closed_at ?? null,
			})),
	);

	// Recently closed PRs, whenever they were opened: this is what says whether
	// anyone is still on the other side merging work.
	const closedPrs = await fetcher.conditional<
		Awaited<ReturnType<Octokit["rest"]["pulls"]["list"]>>["data"],
		{ merged: string[]; total: number }
	>(
		`${repo}:closed`,
		(headers) =>
			octokit.rest.pulls.list({
				owner,
				repo: name,
				state: "closed",
				sort: "updated",
				direction: "desc",
				per_page: PRS_PER_PAGE,
				headers,
			}),
		(data) => ({
			merged: data
				.map((pr) => pr.merged_at)
				.filter((value): value is string => !!value)
				.sort((a, b) => new Date(b).getTime() - new Date(a).getTime()),
			total: data.length,
		}),
	);

	return {
		repo,
		isArchived: meta.archived,
		isDisabled: meta.disabled,
		pushedAt: meta.pushed_at,
		openPrCount: createdPrs.filter((pr) => !pr.closedAt && !pr.mergedAt).length,
		stars: meta.stars,
		createdPrs,
		createdPrsTruncated: createdPrs.length >= PRS_PER_PAGE,
		mergedAt: closedPrs.merged,
		mergedPrsTruncated: closedPrs.total >= PRS_PER_PAGE,
	};
}

/** Runs `worker` over the items, `limit` of them in flight at a time. */
async function pooled<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;

	async function run() {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index], index);
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => run()),
	);

	return results;
}

function pad(value: string, width: number, align: "left" | "right" = "left") {
	return align === "left" ? value.padEnd(width) : value.padStart(width);
}

function days(value: number | null) {
	if (value == null) {
		return "never";
	}
	if (value < 1) {
		return "today";
	}
	return `${Math.round(value)}d`;
}

function printTable(results: RepoLiveness[]) {
	const columns: {
		header: string;
		align?: "right";
		value: (item: RepoLiveness) => string;
	}[] = [
		{ header: "REPO", value: (item) => item.repo },
		{ header: "SCORE", align: "right", value: (item) => item.score.toFixed(1) },
		{ header: "STATE", value: (item) => item.label },
		{
			header: "PRS/30D",
			align: "right",
			value: (item) => Math.round(item.prsPerMonth).toString(),
		},
		{
			header: "MERGED/30D",
			align: "right",
			value: (item) => Math.round(item.mergedPerMonth).toString(),
		},
		{
			header: "MERGE%",
			align: "right",
			value: (item) =>
				item.mergeRate == null ? "—" : `${Math.round(item.mergeRate * 100)}`,
		},
		{
			header: "LAST PR",
			align: "right",
			value: (item) => days(item.daysSinceLastPr),
		},
		{
			header: "LAST MERGE",
			align: "right",
			value: (item) => days(item.daysSinceLastMerge),
		},
		{
			header: "LAST PUSH",
			align: "right",
			value: (item) => days(item.daysSincePush),
		},
		{
			header: "OPEN",
			align: "right",
			value: (item) => item.openPrCount.toString(),
		},
		{
			header: "V/F/M",
			value: (item) =>
				`${item.breakdown.volume.toFixed(0)}/${item.breakdown.freshness.toFixed(0)}/${item.breakdown.maintenance.toFixed(0)}`,
		},
	];

	const widths = columns.map((column) =>
		Math.max(
			column.header.length,
			...results.map((item) => column.value(item).length),
		),
	);

	console.log(
		columns
			.map((column, index) => pad(column.header, widths[index], column.align))
			.join("  "),
	);

	for (const item of results) {
		console.log(
			columns
				.map((column, index) =>
					pad(column.value(item), widths[index], column.align),
				)
				.join("  "),
		);
	}
}

function printSummary(results: RepoLiveness[]) {
	const bands: [string, (item: RepoLiveness) => boolean][] = [
		["very active (8.5+)", (item) => item.score >= 8.5],
		["active (7–8.5)", (item) => item.score >= 7 && item.score < 8.5],
		["steady (5–7)", (item) => item.score >= 5 && item.score < 7],
		["slowing (3–5)", (item) => item.score >= 3 && item.score < 5],
		["stale (1.5–3)", (item) => item.score >= 1.5 && item.score < 3],
		["dead (<1.5)", (item) => item.score < 1.5],
	];

	const average =
		results.reduce((total, item) => total + item.score, 0) /
		(results.length || 1);

	console.log(`\n${results.length} repos, average score ${average.toFixed(1)}`);
	for (const [label, matches] of bands) {
		const count = results.filter(matches).length;
		if (count) {
			console.log(`  ${pad(label, 20)} ${count}`);
		}
	}

	const drops = results.filter((item) => item.score < 3);
	if (drops.length) {
		console.log(
			`\nWorth dropping from shared/daily-scan.ts (score < 3):\n  ${drops
				.map((item) => `${item.repo} (${item.score.toFixed(1)})`)
				.join("\n  ")}`,
		);
	}
}

function readCache(file?: string): Cache {
	if (!file || !existsSync(file)) {
		return {};
	}
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as Cache;
	} catch {
		console.error(`  ignoring unreadable cache at ${file}`);
		return {};
	}
}

function writeCache(file: string | undefined, cache: Cache) {
	if (!file) {
		return;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(cache));
}

async function main(options: Options) {
	// Same token order as the hourly scan, so a local run draws from the same
	// bucket it is trying not to exhaust.
	const token =
		process.env.NUXT_GITHUB_TOKEN_ANASTELLINE ??
		process.env.GITHUB_TOKEN ??
		process.env.NUXT_GITHUB_TOKEN;

	if (!token) {
		throw new Error(
			"NUXT_GITHUB_TOKEN_ANASTELLINE environment variable is not set",
		);
	}

	const octokit = new Octokit({ auth: token });
	const cache = readCache(options.cacheFile);
	const fetcher = createFetcher(octokit, cache);
	const now = new Date();
	const results: RepoLiveness[] = [];
	const missing: string[] = [];

	console.error(
		`Scoring ${options.repos.length} repos over the last ${options.lookbackDays} days...`,
	);

	let done = 0;
	let stoppedAt: string | null = null;

	await pooled(options.repos, options.concurrency, async (repo) => {
		if (stoppedAt) {
			return;
		}

		// Stop while there is still budget left rather than failing halfway and
		// leaving the hourly scan with nothing.
		if (fetcher.remaining < RATE_LIMIT_FLOOR) {
			stoppedAt = repo;
			return;
		}

		try {
			const activity = await fetchActivity(fetcher, repo);
			results.push(scoreRepoLiveness(activity, now, options.lookbackDays));
		} catch (error) {
			const status = statusOf(error);
			if (status === 404 || status === 451) {
				missing.push(repo);
			} else {
				missing.push(repo);
				console.error(`  ${repo}: ${(error as Error).message}`);
			}
		}

		done++;
		if (done % 25 === 0 || done === options.repos.length) {
			console.error(`  ${done}/${options.repos.length}`);
		}
	});

	writeCache(options.cacheFile, cache);

	// Repo name breaks ties so two runs over the same data print the same order.
	results.sort((a, b) => {
		const byScore =
			options.sort === "best" ? b.score - a.score : a.score - b.score;
		return byScore || a.repo.localeCompare(b.repo);
	});

	const shown =
		options.below == null
			? results
			: results.filter((item) => item.score < (options.below as number));

	if (shown.length) {
		printTable(shown);
	} else {
		console.log("No repos matched.");
	}
	printSummary(results);

	if (missing.length) {
		console.log(
			`\nCould not read ${missing.length} repo(s) — renamed, deleted or private:\n  ${missing.join("\n  ")}`,
		);
	}

	if (stoppedAt) {
		console.log(
			`\nStopped at ${stoppedAt}: fewer than ${RATE_LIMIT_FLOOR} API calls left${
				fetcher.reset ? ` until ${fetcher.reset.toISOString()}` : ""
			}. Re-run later — the cache keeps what was already read.`,
		);
	}

	if (Number.isFinite(fetcher.remaining)) {
		console.log(`\nRate limit remaining: ${fetcher.remaining}`);
	}

	if (options.jsonFile) {
		writeFileSync(
			options.jsonFile,
			`${JSON.stringify(
				{
					generated_at: now.toISOString(),
					lookback_days: options.lookbackDays,
					missing,
					results,
				},
				null,
				2,
			)}\n`,
		);
		console.log(`\nWrote ${options.jsonFile}`);
	}
}

function flag(args: string[], name: string) {
	const prefix = `--${name}=`;
	const found = args.find((arg) => arg.startsWith(prefix));
	return found ? found.slice(prefix.length) : undefined;
}

const args = process.argv.slice(2);

const reposArg = flag(args, "repos");
const limitArg = flag(args, "limit");
const lookbackArg = flag(args, "lookback");
const belowArg = flag(args, "below");
const concurrencyArg = flag(args, "concurrency");
const jsonArg = flag(args, "json");
const cacheArg = flag(args, "cache");

const selected = reposArg
	? reposArg
			.split(",")
			.map((repo) => repo.trim())
			.filter(Boolean)
	: [...libraries];

const repos = limitArg ? selected.slice(0, parseInt(limitArg, 10)) : selected;

const invalid = repos.filter((repo) => repo.split("/").length !== 2);
if (invalid.length) {
	console.error(`Fatal error: not owner/name — ${invalid.join(", ")}`);
	process.exit(1);
}

main({
	repos,
	lookbackDays: lookbackArg ? parseInt(lookbackArg, 10) : LOOKBACK_DAYS,
	concurrency: concurrencyArg ? parseInt(concurrencyArg, 10) : CONCURRENT_REPOS,
	sort: flag(args, "sort") === "best" ? "best" : "worst",
	...(belowArg && { below: parseFloat(belowArg) }),
	...(jsonArg && { jsonFile: jsonArg }),
	...(!args.includes("--no-cache") && { cacheFile: cacheArg ?? CACHE_FILE }),
}).catch((error) => {
	console.error("Fatal error:", error.message);
	process.exit(1);
});
