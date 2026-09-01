import type { EcosystemHealthItem } from "../types/ecosystem-health";
import { INSUFFICIENT_DATA_SCORE } from "./health-stats";

/**
 * What one repo did on one day. Kept out of daily-scan-results.json on
 * purpose: ~80 repos a day would multiply that file by two orders of
 * magnitude, and nothing reading the health graph needs the breakdown.
 */
export type DailyRepoScore = {
	/** PRs opened in the repo that day, scored or not. */
	count: number;
	/** The scored ones — an insufficient-data row carries a sentinel, not a score. */
	scoredCount: number;
	/**
	 * Summed rather than averaged, like the daily rollup: a sum re-rolls and
	 * merges without carrying the weight it was taken over. Divide by
	 * `scoredCount` for the day's mean score.
	 */
	scoreSum: number;
};

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

		if (!wanted.has(date)) {
			return;
		}

		const repos = scores[date] ?? {};
		const repo = repos[result.repo_name] ?? {
			count: 0,
			scoredCount: 0,
			scoreSum: 0,
		};

		scores[date] = repos;
		repos[result.repo_name] = repo;

		repo.count += 1;

		if (result.score !== INSUFFICIENT_DATA_SCORE) {
			repo.scoredCount += 1;
			repo.scoreSum += result.score;
		}
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
 * the mean over the range is the summed score over the summed scored count —
 * not an average of daily averages, which would weight a quiet day like a
 * busy one.
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
		Object.entries(scoresByDate[date] ?? {}).forEach(([name, score]) => {
			const total = totals[name] ?? { count: 0, scoredCount: 0, scoreSum: 0 };

			totals[name] = total;

			total.count += score.count;
			total.scoredCount += score.scoredCount;
			total.scoreSum += score.scoreSum;
		});
	});

	return totals;
}
