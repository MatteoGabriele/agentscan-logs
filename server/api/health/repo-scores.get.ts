import { defineHandler, HTTPError } from "nitro";
import type { DailyRepoScores } from "../../../shared/utils/daily-repo-scores";
import {
	getDatesInRange,
	isValidScoreDate,
	sumRepoScoresOverDates,
} from "../../../shared/utils/daily-repo-scores";
import { classifyByScore } from "../../../shared/utils/health-stats";
import { round } from "../../../shared/utils/numbers";
import { readTextAsset } from "../../utils/read-text-asset";

/**
 * The per-repo half of the daily rollup, served on its own so the health
 * endpoint stays the size it is.
 *
 *   /api/health/repo-scores                              → the dates on file
 *   /api/health/repo-scores?date=2026-08-29              → every repo that day
 *   /api/health/repo-scores?date=2026-08-29&repo=x/y     → one repo that day
 *   /api/health/repo-scores?from=2026-08-25&to=2026-08-29
 *                                → every repo, summed across the whole range
 *   /api/health/repo-scores?from=…&to=…&repo=x/y → one repo across the range
 *
 * `from` and `to` are inclusive and either may stand alone: a missing `from`
 * runs from the first day on file, a missing `to` to the last. A day appears
 * here only once the daily rollup has completed it, so a date that is missing
 * is a day still being measured, not an error — a range simply answers with
 * the days it does hold.
 */
export default defineHandler(async (event) => {
	const date = event.url.searchParams.get("date");
	const from = event.url.searchParams.get("from");
	const to = event.url.searchParams.get("to");

	// Validated before the read so a bad query answers 400 rather than falling
	// into the catch below, which reports every failure as ours.
	[date, from, to].forEach((value) => {
		if (value !== null && !isValidScoreDate(value)) {
			throw new HTTPError({
				status: 400,
				message: `Dates must be ISO calendar dates (YYYY-MM-DD), got "${value}"`,
			});
		}
	});

	if (from && to && from > to) {
		throw new HTTPError({
			status: 400,
			message: `"from" (${from}) must not be later than "to" (${to})`,
		});
	}

	try {
		const content = await readTextAsset("daily-repo-scores.json");
		const scoresByDate = JSON.parse(content) as DailyRepoScores;
		const dates = Object.keys(scoresByDate).sort();

		if (!date && !from && !to) {
			return { dates };
		}

		// A single `date` is the range that starts and ends on it, so both
		// shapes fold through the same summing path.
		const rangeStart = date ?? from ?? dates[0] ?? "";
		const rangeEnd = date ?? to ?? dates[dates.length - 1] ?? "";
		const rangeDates = getDatesInRange({
			dates,
			from: rangeStart,
			to: rangeEnd,
		});

		const repoName = event.url.searchParams.get("repo");
		const totals = sumRepoScoresOverDates({
			scoresByDate,
			dates: rangeDates,
		});

		const repos = Object.entries(totals)
			.filter(([name]) => !repoName || name === repoName)
			.map(([name, [count, scoreSum]]) => {
				// A repo is on file only once it has a scored PR, so the pair always
				// divides. The mean is on the same 0-100 scale a single scan uses, so
				// it reads back through the same thresholds.
				const averageScore = round(scoreSum / count, 1);

				return {
					repo_name: name,
					count,
					scoreSum,
					averageScore,
					classification: classifyByScore(averageScore),
				};
			})
			.sort((a, b) => b.count - a.count);

		if (date) {
			return { date, dates, repos };
		}

		return {
			from: rangeStart,
			to: rangeEnd,
			// The days inside the range that were actually measured, so a caller
			// can tell a quiet repo from a range that only covers two days.
			rangeDates,
			dates,
			repos,
		};
	} catch (error) {
		console.error("Daily repo scores fetch error:", error);
		throw new HTTPError({
			status: 500,
			message: "Failed to fetch daily repo scores",
		});
	}
});
