import { defineHandler, HTTPError } from "nitro";
import type { DailyRepoScores } from "../../../shared/utils/daily-repo-scores";
import {
	getDatesInRange,
	getRepoScoresPerDate,
	isValidScoreDate,
} from "../../../shared/utils/daily-repo-scores";
import { readTextAsset } from "../../utils/read-text-asset";

/**
 * The per-repo half of the daily rollup, served on its own so the health
 * endpoint stays the size it is.
 *
 *   ?                          → the dates on file
 *   ?date=2026-08-29           → that day's repos
 *   ?from=…&to=…               → one entry per measured day in the range
 *   &repo=x/y                  → narrows either shape to one repo
 *
 * `from` and `to` are inclusive and either may stand alone. A range answers
 * with the measured days it holds; a missing day is one still being measured,
 * not an error.
 */
export default defineHandler(async (event) => {
	const date = event.url.searchParams.get("date");
	const from = event.url.searchParams.get("from");
	const to = event.url.searchParams.get("to");

	// Before the read, so a bad query answers 400 instead of the catch's 500.
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

		// A single `date` is the range starting and ending on it.
		const rangeStart = date ?? from ?? dates[0] ?? "";
		const rangeEnd = date ?? to ?? dates[dates.length - 1] ?? "";
		const rangeDates = getDatesInRange({
			dates,
			from: rangeStart,
			to: rangeEnd,
		});

		const days = getRepoScoresPerDate({
			scoresByDate,
			dates: rangeDates,
			repo: event.url.searchParams.get("repo"),
		});

		if (date) {
			return { date, dates, repos: days[0]?.repos ?? [] };
		}

		return {
			from: rangeStart,
			to: rangeEnd,
			dates,
			days,
		};
	} catch (error) {
		console.error("Daily repo scores fetch error:", error);
		throw new HTTPError({
			status: 500,
			message: "Failed to fetch daily repo scores",
		});
	}
});
