import { defineHandler, HTTPError } from "nitro";
import type { DailyRepoScores } from "../../../shared/utils/daily-repo-scores";
import { classifyByScore } from "../../../shared/utils/health-stats";
import { round } from "../../../shared/utils/numbers";
import { readTextAsset } from "../../utils/read-text-asset";

/**
 * The per-repo half of the daily rollup, served on its own so the health
 * endpoint stays the size it is.
 *
 *   /api/health/repo-scores                          → the dates on file
 *   /api/health/repo-scores?date=2026-08-29          → every repo that day
 *   /api/health/repo-scores?date=2026-08-29&repo=x/y → one repo that day
 *
 * A day appears here only once the daily rollup has completed it, so a date
 * that is missing is a day still being measured, not an error.
 */
export default defineHandler(async (event) => {
	try {
		const content = await readTextAsset("daily-repo-scores.json");
		const scoresByDate = JSON.parse(content) as DailyRepoScores;
		const dates = Object.keys(scoresByDate).sort();

		const date = event.url.searchParams.get("date");

		if (!date) {
			return { dates };
		}

		const repoName = event.url.searchParams.get("repo");
		const day = scoresByDate[date] ?? {};

		const repos = Object.entries(day)
			.filter(([name]) => !repoName || name === repoName)
			.map(([name, score]) => ({
				repo_name: name,
				...score,
				// The mean of the day's PRs, on the same 0-100 scale a single scan
				// uses, so it reads back through the same thresholds.
				averageScore: score.scoredCount
					? round(score.scoreSum / score.scoredCount, 1)
					: null,
			}))
			.map((entry) => ({
				...entry,
				classification:
					entry.averageScore == null
						? null
						: classifyByScore(entry.averageScore),
			}))
			.sort((a, b) => b.count - a.count);

		return { date, dates, repos };
	} catch (error) {
		console.error("Daily repo scores fetch error:", error);
		throw new HTTPError({
			status: 500,
			message: "Failed to fetch daily repo scores",
		});
	}
});
