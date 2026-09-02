import type { EcosystemHealthItem } from "../types/ecosystem-health";
import { INSUFFICIENT_DATA_SCORE } from "./health-stats";

/**
 * One repo's day as `[count, scoreSum]`. A tuple because the file holds a row
 * per repo per day and the keys would outweigh the numbers. `count` is scored
 * PRs only, so the pair always divides into a mean.
 */
export type DailyRepoScore = [count: number, scoreSum: number];

/** Keyed by date first, so a lookup is `file[date][repo]`. */
export type DailyRepoScores = Record<string, Record<string, DailyRepoScore>>;

function getDate(timestamp: string): string {
	return timestamp.slice(0, 10);
}

/**
 * Folds the hourly rows into per-repo day totals, for the days named in
 * `dates` and no others — the days the daily rollup just completed, so both
 * files agree on which days exist.
 */
export function getRepoScoresByDate(
	results: EcosystemHealthItem[],
	dates: string[],
): DailyRepoScores {
	const wanted = new Set(dates);
	const scores: DailyRepoScores = {};

	results.forEach((result) => {
		const date = getDate(result.created_at);

		if (!wanted.has(date) || result.score === INSUFFICIENT_DATA_SCORE) {
			return;
		}

		const repos = scores[date] ?? {};
		const [count, scoreSum] = repos[result.repo_name] ?? [0, 0];

		scores[date] = repos;
		repos[result.repo_name] = [count + 1, scoreSum + result.score];
	});

	return scores;
}

/** A stored day is never rewritten, so a rerun changes nothing. */
export function mergeRepoScores(
	stored: DailyRepoScores,
	measured: DailyRepoScores,
): DailyRepoScores {
	const merged = { ...stored };

	Object.entries(measured).forEach(([date, repos]) => {
		merged[date] ??= repos;
	});

	return Object.fromEntries(
		Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
	);
}

/** One repo per line — `JSON.stringify(…, null, 2)` spends three per pair. */
export function stringifyRepoScores(scores: DailyRepoScores): string {
	const days = Object.entries(scores).map(([date, repos]) => {
		const rows = Object.entries(repos).map(
			([name, [count, scoreSum]]) =>
				`    ${JSON.stringify(name)}: [${count}, ${scoreSum}]`,
		);

		return `  ${JSON.stringify(date)}: {\n${rows.join(",\n")}\n  }`;
	});

	return `{\n${days.join(",\n")}\n}\n`;
}

/** ISO calendar dates only, so a string compare is a date compare. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidScoreDate(date: string): boolean {
	return (
		DATE_PATTERN.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
	);
}

/** The measured days inside an inclusive `from`..`to` range. */
export function getDatesInRange({
	dates,
	from,
	to,
}: {
	dates: string[];
	from: string;
	to: string;
}): string[] {
	return dates.filter((date) => date >= from && date <= to).sort();
}

export type RepoScoreRow = { name: string; count: number; scoreSum: number };

export type RepoScoreDay = { date: string; repos: RepoScoreRow[] };

/**
 * One row per repo per day, never folded into a total. A day is kept even
 * when `repo` filters it empty, so a quiet day reads as quiet, not as a gap.
 */
export function getRepoScoresPerDate({
	scoresByDate,
	dates,
	repo,
}: {
	scoresByDate: DailyRepoScores;
	dates: string[];
	repo?: string | null;
}): RepoScoreDay[] {
	return dates.map((date) => ({
		date,
		repos: Object.entries(scoresByDate[date] ?? {})
			.filter(([name]) => !repo || name === repo)
			.map(([name, [count, scoreSum]]) => ({ name, count, scoreSum }))
			.sort((a, b) => b.count - a.count),
	}));
}
