import type { EcosystemHealthItem } from "../types/ecosystem-health";
import { INSUFFICIENT_DATA_SCORE } from "./health-stats";

/**
 * What one repo did on one day, as `[count, scoreSum]`. Kept out of
 * daily-scan-results.json on purpose: ~80 repos a day would multiply that
 * file by two orders of magnitude, and nothing reading the health graph needs
 * the breakdown. A tuple rather than an object because the file is written
 * once a day for every repo, and the keys would outweigh the numbers.
 *
 * `count` is the scored PRs only — an insufficient-data row is not counted at
 * all, so the pair always divides into a mean. `scoreSum` is summed rather
 * than averaged, like the daily rollup: a sum re-rolls and merges without
 * carrying the weight it was taken over.
 */
export type DailyRepoScore = [count: number, scoreSum: number];

/**
 * Keyed by date first so a lookup is `file[date][repo]` — the whole point of
 * the split file is answering "what did nuxt score on the 29th" without
 * reading a day's PR rows back.
 */
export type DailyRepoScores = Record<string, Record<string, DailyRepoScore>>;

function getDate(timestamp: string): string {
	return timestamp.slice(0, 10);
}

/**
 * Folds the hourly rows into per-repo day totals, for the days named in
 * `dates` and no others. The caller passes the days the daily rollup just
 * completed, so both files always agree on which days exist.
 */
export function getRepoScoresByDate(
	results: EcosystemHealthItem[],
	dates: string[],
): DailyRepoScores {
	const wanted = new Set(dates);
	const scores: DailyRepoScores = {};

	results.forEach((result) => {
		const date = getDate(result.created_at);

		// An unscored row says nothing about the repo's day, so it is dropped
		// rather than stored as a count it can never be divided into.
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

/**
 * One repo per line. `JSON.stringify(scores, null, 2)` would spend three
 * lines on every pair, which is the opposite of what the tuple is for.
 */
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

/**
 * The days on file that fall inside an inclusive `from`..`to` range. A range
 * naming days that were never measured is not an error — it just answers with
 * the days that were.
 */
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

/**
 * Folds several days into one per-repo total. The file stores sums precisely
 * so this works: a range re-rolls into the same shape a single day has, and
 * the mean over the range is the summed score over the summed count — not an
 * average of daily averages, which would weight a quiet day like a busy one.
 */
export function sumRepoScoresOverDates({
	scoresByDate,
	dates,
}: {
	scoresByDate: DailyRepoScores;
	dates: string[];
}): Record<string, DailyRepoScore> {
	const totals: Record<string, DailyRepoScore> = {};

	dates.forEach((date) => {
		Object.entries(scoresByDate[date] ?? {}).forEach(
			([name, [count, scoreSum]]) => {
				const [total, sum] = totals[name] ?? [0, 0];

				totals[name] = [total + count, sum + scoreSum];
			},
		);
	});

	return totals;
}
