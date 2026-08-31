import { describe, expect, it } from "vitest";
import type { EcosystemHealthItem } from "../types/ecosystem-health";
import {
	type DailyRepoScores,
	getRepoScoresByDate,
	mergeRepoScores,
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
				"nuxt/nuxt": { count: 2, scoredCount: 2, scoreSum: 140 },
				"vuejs/core": { count: 1, scoredCount: 1, scoreSum: 10 },
			},
		});
	});

	it("counts an insufficient-data row without scoring it", () => {
		const scores = getRepoScoresByDate(
			[
				createEcosystemHealthItem({ score: 80 }),
				createEcosystemHealthItem({ score: INSUFFICIENT_DATA_SCORE }),
			],
			["2026-06-10"],
		);

		expect(scores["2026-06-10"]["nuxt/nuxt"]).toEqual({
			count: 2,
			scoredCount: 1,
			scoreSum: 80,
		});
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
		"2026-06-10": { "nuxt/nuxt": { count: 2, scoredCount: 2, scoreSum: 140 } },
	};

	it("adds a new day and sorts the file by date", () => {
		const merged = mergeRepoScores(
			{
				"2026-06-11": {
					"nuxt/nuxt": { count: 1, scoredCount: 1, scoreSum: 10 },
				},
			},
			stored,
		);

		expect(Object.keys(merged)).toEqual(["2026-06-10", "2026-06-11"]);
	});

	it("never rewrites a day it already holds", () => {
		const merged = mergeRepoScores(stored, {
			"2026-06-10": { "nuxt/nuxt": { count: 9, scoredCount: 9, scoreSum: 9 } },
		});

		expect(merged).toEqual(stored);
	});
});
