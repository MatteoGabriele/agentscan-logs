import { defineHandler, HTTPError } from "nitro";
import { unpack } from "../../../shared/utils/compactor";
import {
	applyCumulativeTrends,
	fillEmptyHourlyBuckets,
	getClassificationStatsByScanTime,
} from "../../../shared/utils/count-classification-by-date";
import { roundToClosestHour } from "../../../shared/utils/dates";
import { WINDOW_MAX_HOURS } from "../../../shared/utils/health-history-window";
import { readTextAsset } from "../../utils/read-text-asset";

export default defineHandler(async () => {
	try {
		const content = await readTextAsset("hourly-window-scan-results.txt");

		//   created_at: fromUnixSecs(numCreatedTs)
		//   score: Number(score)
		//   pr_key: base64UrlToHex(prKeyB64!)
		//   pr_status: (STATUS_DECODE[status!] ?? status!) as PrStatus
		//   user_created_at: fromUnixSecs(numUserCreatedTs)
		//   user_public_repos_count: numPublicRepos
		//   events_count: numEvents
		//   repo_name: repos[numRepoIdx] ?? ''
		//   is_bounty: isBounty === '1'
		const results = unpack(content).map((entry) => ({
			...entry,
			created_at: roundToClosestHour(entry.created_at),
		}));

		// An hour with no PR opened writes no row at all, so it has to be
		// added as an empty bucket instead of being skipped by the chart.
		const countsByScanTime = fillEmptyHourlyBuckets({
			countsByHour: getClassificationStatsByScanTime(results),
			maxHours: WINDOW_MAX_HOURS,
		});
		const categoryProgression = applyCumulativeTrends(countsByScanTime);
		const scanTimes = Object.keys(countsByScanTime).sort();

		return {
			results,
			categoryProgression,
			countsByScanTime,
			scanTimes,
		};
	} catch (error) {
		console.error("Hourly window scan fetch error:", error);
		throw new HTTPError({
			status: 500,
			message: "Failed to fetch hourly window scan results",
		});
	}
});
