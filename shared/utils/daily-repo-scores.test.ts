import { describe, expect, it } from "vitest";
import type { EcosystemHealthItem } from "../types/ecosystem-health";
import {
	type DailyRepoScores,
	getDatesInRange,
	getRepoScoresByDate,
	isValidScoreDate,
	mergeRepoScores,
	stringifyRepoScores,
	sumRepoScoresOverDates,
} from "./daily-repo-scores";
import { INSUFFICIENT_DATA_SCORE } from "./health-stats";

function createEcosystemHealthItem(
	item: Partial<EcosystemHealthItem>,
): EcosystemHealthItem {
	return {
		created_at: "2026-06-10T00:00:00.000Z",
		score: 90,
		pr_status: "open",
		repo_name: "nuxt/nuxt",
		is_bounty: false,
		confidence: 0,
		evidence_groups: [],
		...item,
	} as EcosystemHealthItem;
}

describe("getRepoScoresByDate", () => {
	it("sums a repo's scores per day", () => {
		const scores = getRepoScoresByDate(
			[
				createEcosystemHealthItem({
					created_at: "2026-06-10T01:00:00.000Z",
					score: 80,
				}),
				createEcosystemHealthItem({
					created_at: "2026-06-10T05:00:00.000Z",
					score: 60,
				}),
				createEcosystemHealthItem({
					created_at: "2026-06-10T05:00:00.000Z",
					score: 10,
					repo_name: "vuejs/core",
				}),
			],
			["2026-06-10"],
		);

		expect(scores).toEqual({
			"2026-06-10": {
				"nuxt/nuxt": [2, 140],
				"vuejs/core": [1, 10],
			},
		});
	});

	it("leaves an insufficient-data row out of the count", () => {
		const scores = getRepoScoresByDate(
			[
				createEcosystemHealthItem({ score: 80 }),
				createEcosystemHealthItem({ score: INSUFFICIENT_DATA_SCORE }),
			],
			["2026-06-10"],
		);

		expect(scores["2026-06-10"]["nuxt/nuxt"]).toEqual([1, 80]);
	});

	it("keeps a repo off the day when nothing it opened was scored", () => {
		const scores = getRepoScoresByDate(
			[createEcosystemHealthItem({ score: INSUFFICIENT_DATA_SCORE })],
			["2026-06-10"],
		);

		expect(scores).toEqual({});
	});

	it("keeps only the days it was asked for", () => {
		const scores = getRepoScoresByDate(
			[
				createEcosystemHealthItem({ created_at: "2026-06-10T01:00:00.000Z" }),
				createEcosystemHealthItem({ created_at: "2026-06-11T01:00:00.000Z" }),
			],
			["2026-06-10"],
		);

		expect(Object.keys(scores)).toEqual(["2026-06-10"]);
	});
});

describe("mergeRepoScores", () => {
	const stored: DailyRepoScores = {
		"2026-06-10": { "nuxt/nuxt": [2, 140] },
	};

	it("adds a new day and sorts the file by date", () => {
		const merged = mergeRepoScores(
			{ "2026-06-11": { "nuxt/nuxt": [1, 10] } },
			stored,
		);

		expect(Object.keys(merged)).toEqual(["2026-06-10", "2026-06-11"]);
	});

	it("never rewrites a day it already holds", () => {
		const merged = mergeRepoScores(stored, {
			"2026-06-10": { "nuxt/nuxt": [9, 9] },
		});

		expect(merged).toEqual(stored);
	});
});

describe("getDatesInRange", () => {
	const dates = ["2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12"];

	it("keeps the days inside an inclusive range", () => {
		expect(
			getDatesInRange({ dates, from: "2026-06-10", to: "2026-06-11" }),
		).toEqual(["2026-06-10", "2026-06-11"]);
	});

	it("answers with the days it holds when the range asks for more", () => {
		expect(
			getDatesInRange({ dates, from: "2026-06-01", to: "2026-12-31" }),
		).toEqual(dates);
	});

	it("is empty when no measured day falls in the range", () => {
		expect(
			getDatesInRange({ dates, from: "2026-07-01", to: "2026-07-05" }),
		).toEqual([]);
	});
});

describe("sumRepoScoresOverDates", () => {
	const scoresByDate: DailyRepoScores = {
		"2026-06-10": {
			"nuxt/nuxt": [2, 140],
			"vuejs/core": [1, 10],
		},
		"2026-06-11": {
			"nuxt/nuxt": [1, 60],
		},
		"2026-06-12": {
			"vuejs/core": [5, 400],
		},
	};

	it("sums a repo across the days it was given", () => {
		expect(
			sumRepoScoresOverDates({
				scoresByDate,
				dates: ["2026-06-10", "2026-06-11"],
			}),
		).toEqual({
			"nuxt/nuxt": [3, 200],
			"vuejs/core": [1, 10],
		});
	});

	it("ignores a day that was never measured", () => {
		expect(
			sumRepoScoresOverDates({
				scoresByDate,
				dates: ["2026-06-10", "2026-06-30"],
			}),
		).toEqual(scoresByDate["2026-06-10"]);
	});

	it("leaves the stored days untouched", () => {
		sumRepoScoresOverDates({
			scoresByDate,
			dates: ["2026-06-10", "2026-06-11"],
		});

		expect(scoresByDate["2026-06-10"]["nuxt/nuxt"]).toEqual([2, 140]);
	});
});

describe("stringifyRepoScores", () => {
	it("writes one repo per line as a pair", () => {
		expect(
			stringifyRepoScores({
				"2026-06-10": { "nuxt/nuxt": [2, 140], "vuejs/core": [1, 10] },
				"2026-06-11": { "nuxt/nuxt": [1, 60] },
			}),
		).toBe(
			[
				"{",
				'  "2026-06-10": {',
				'    "nuxt/nuxt": [2, 140],',
				'    "vuejs/core": [1, 10]',
				"  },",
				'  "2026-06-11": {',
				'    "nuxt/nuxt": [1, 60]',
				"  }",
				"}",
				"",
			].join("\n"),
		);
	});

	it("round-trips through JSON.parse", () => {
		const scores: DailyRepoScores = {
			"2026-06-10": { "nuxt/nuxt": [2, 140] },
		};

		expect(JSON.parse(stringifyRepoScores(scores))).toEqual(scores);
	});
});

describe("isValidScoreDate", () => {
	it("accepts an ISO calendar date", () => {
		expect(isValidScoreDate("2026-06-10")).toBe(true);
	});

	it("rejects anything that is not one", () => {
		[
			"2026-6-10",
			"10-06-2026",
			"2026-06-10T00:00:00Z",
			"2026-13-10",
			"",
		].forEach((value) => {
			expect(isValidScoreDate(value)).toBe(false);
		});
	});
});
