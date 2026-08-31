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
