import { defineHandler, HTTPError } from "nitro";
import { applyCumulativeTrends } from "../../../shared/utils/count-classification-by-date";
import type { DailyScanEntry } from "../../../shared/utils/daily-rollup";
import { getDailyCountsByDate } from "../../../shared/utils/daily-rollup";
import { getRecentDailyEntries } from "../../../shared/utils/health-history-window";
import { readTextAsset } from "../../utils/read-text-asset";

export default defineHandler(async (event) => {
	try {
		const isFullHistory = event.url.searchParams.get("full") === "true";

		const content = await readTextAsset("daily-scan-results.json");

		const allEntries = JSON.parse(content) as DailyScanEntry[];
		const entries = isFullHistory
			? allEntries
			: getRecentDailyEntries(allEntries);

		const countsByDate = getDailyCountsByDate(entries);
		const categoryProgression = applyCumulativeTrends(countsByDate);
		const dates = Object.keys(countsByDate).sort();
		const scanTimes = dates.map(
			(date) => countsByDate[date]?.createdAt ?? `${date}T00:00:00.000Z`,
		);

		return {
			entries,
			categoryProgression,
			countsByDate,
			dates,
			scanTimes,
		};
	} catch (error) {
		console.error("Daily scan fetch error:", error);
		throw new HTTPError({
			status: 500,
			message: "Failed to fetch daily scan results",
		});
	}
});
