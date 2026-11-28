import { describe, expect, it } from "vitest";
import type { EcosystemHealthItem } from "../types/ecosystem-health";
import { getClassificationStatsByDate } from "./count-classification-by-date";
import type { DailyScanEntry } from "./daily-rollup";
import {
	getCompletedDailyEntries,
	getDailyCountsByDate,
	mergeDailyEntries,
	stringifyDailyEntries,
} from "./daily-rollup";
import { classifyByScore } from "./health-stats";

function createEcosystemHealthItem(
	item: Partial<EcosystemHealthItem>,
): EcosystemHealthItem {
	return {
		created_at: "2026-06-10T00:00:00.000Z",
		score: 90,
		pr_status: "open",
		is_bounty: false,
		...item,
	} as EcosystemHealthItem;
}

function createFullDay(date: string, score: number): EcosystemHealthItem[] {
	return Array.from({ length: 24 }, (_, hour) =>
		createEcosystemHealthItem({
			created_at: `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`,
			score,
		}),
	);
}

/**
 * Folds rows into stored days directly, with none of the retention and
 * completeness rules the scan applies before it writes one. The reader tests
 * below are about how an entry reads back, not about when it earns its place
 * in the file, so they build their fixtures rather than scanning for them.
 */
function foldIntoStoredEntries(
	results: EcosystemHealthItem[],
): DailyScanEntry[] {
	const entriesByDate = new Map<string, DailyScanEntry>();

	for (const result of results) {
		const date = result.created_at.slice(0, 10);
		const entry =
			entriesByDate.get(date) ??
			createDailyScanEntry({
				date,
				createdAt: result.created_at,
				hours: 0,
				classifications: {
					organic: createClassificationCounts(),
					mixed: createClassificationCounts(),
					automation: createClassificationCounts(),
					"insufficient-data": createClassificationCounts(),
				},
			});
		const counts = entry.classifications[classifyByScore(result.score)];

		counts.count += 1;
		counts.bountyCount += result.is_bounty ? 1 : 0;
		counts.prStatusCounts[result.pr_status] += 1;
		entry.createdAt =
			result.created_at < entry.createdAt ? result.created_at : entry.createdAt;

		entriesByDate.set(date, entry);
	}

	return [...entriesByDate.values()].sort((a, b) =>
		a.date.localeCompare(b.date),
	);
}

function createClassificationCounts() {
	return {
		count: 0,
		bountyCount: 0,
		prStatusCounts: { open: 0, closed: 0, merged: 0 },
	};
}

function createDailyScanEntry(entry: Partial<DailyScanEntry>): DailyScanEntry {
	return {
		date: "2026-06-10",
		createdAt: "2026-06-10T00:00:00.000Z",
		hours: 24,
		...entry,
	} as DailyScanEntry;
}

describe("getCompletedDailyEntries", () => {
	it("returns one entry per completed day", () => {
		const [entry, ...rest] = getCompletedDailyEntries(
			[
				...createFullDay("2026-06-10", 90),
				createEcosystemHealthItem({ created_at: "2026-06-11T00:00:00.000Z" }),
			],
			"2026-06-11T00:00:00.000Z",
		);

		expect(rest).toEqual([]);
		expect(entry?.date).toBe("2026-06-10");
		expect(entry?.createdAt).toBe("2026-06-10T00:00:00.000Z");
		expect(entry?.hours).toBe(24);
		expect(entry?.classifications.organic.count).toBe(24);
		expect(entry?.classifications.automation.count).toBe(0);
	});

	it("counts bounty hunters, pr statuses and insufficient data apart", () => {
		const [entry] = getCompletedDailyEntries(
			[
				createEcosystemHealthItem({
					created_at: "2026-06-10T00:00:00.000Z",
					score: 10,
					pr_status: "closed",
					is_bounty: true,
				}),
				createEcosystemHealthItem({
					created_at: "2026-06-10T01:00:00.000Z",
					score: 10,
					pr_status: "merged",
				}),
				createEcosystemHealthItem({
					created_at: "2026-06-10T02:00:00.000Z",
					score: -1,
				}),
				createEcosystemHealthItem({ created_at: "2026-06-11T00:00:00.000Z" }),
			],
			"2026-06-11T00:00:00.000Z",
		);

		expect(entry?.classifications.automation).toEqual({
			count: 2,
			bountyCount: 1,
			prStatusCounts: { open: 0, closed: 1, merged: 1 },
		});
		expect(entry?.classifications["insufficient-data"].count).toBe(1);
		expect(entry?.hours).toBe(3);
	});

	it("closes the day on the midnight run, which measures its 23:00 hour", () => {
		const [entry, ...rest] = getCompletedDailyEntries(
			createFullDay("2026-06-10", 90),
			"2026-06-10T23:00:00.000Z",
		);

		expect(rest).toEqual([]);
		expect(entry?.date).toBe("2026-06-10");
		expect(entry?.hours).toBe(24);
	});

	it("closes the day even when its last hours saw no PR at all", () => {
		// The last three hours were scanned but saw no PR, so no row was written
		// for them and the rows stop at 20:00.
		const [entry] = getCompletedDailyEntries(
			createFullDay("2026-06-10", 90).slice(0, 21),
			"2026-06-10T23:00:00.000Z",
		);

		expect(entry?.date).toBe("2026-06-10");
		expect(entry?.hours).toBe(21);
	});

	it("skips the day still being scanned", () => {
		expect(
			getCompletedDailyEntries(
				createFullDay("2026-06-10", 90).slice(0, 13),
				"2026-06-10T12:00:00.000Z",
			),
		).toEqual([]);
	});

	it("skips a day whose first hours already left the window", () => {
		const result = getCompletedDailyEntries(
			[
				createEcosystemHealthItem({ created_at: "2026-06-10T12:00:00.000Z" }),
				createEcosystemHealthItem({ created_at: "2026-06-11T00:00:00.000Z" }),
			],
			"2026-06-11T00:00:00.000Z",
		);

		expect(result).toEqual([]);
	});
});

describe("getDailyCountsByDate", () => {
	// The day the scan pipeline would report for the same rows, so the stored
	// entry can be checked against the numbers already on the graph.
	const rows = [
		...Array.from({ length: 6 }, () =>
			createEcosystemHealthItem({ score: 90 }),
		),
		...Array.from({ length: 3 }, () =>
			createEcosystemHealthItem({ score: 10 }),
		),
		createEcosystemHealthItem({ score: 60 }),
		createEcosystemHealthItem({ score: -1 }),
	];

	it("reads a stored day exactly as the scan pipeline reads the same rows", () => {
		const [entry] = foldIntoStoredEntries(rows);

		expect(getDailyCountsByDate([entry])).toEqual(
			getClassificationStatsByDate(rows),
		);
	});

	it("leaves insufficient-data out of the total and the percentages", () => {
		const [entry] = foldIntoStoredEntries(rows);
		const counts = getDailyCountsByDate([entry])["2026-06-10"];

		// 11 rows were measured, but only the 10 scored ones are aggregated.
		expect(entry?.classifications["insufficient-data"].count).toBe(1);
		expect(counts?.total.count).toBe(10);
		expect(counts?.automation.percentage).toBe(30);
		expect(counts?.organic.percentage).toBe(60);
		expect(counts?.mixed.percentage).toBe(10);
	});

	it("keeps the day sorted and carries its scan time through", () => {
		const entries = foldIntoStoredEntries([
			createEcosystemHealthItem({ created_at: "2026-06-11T09:30:00.000Z" }),
			createEcosystemHealthItem({ created_at: "2026-06-10T04:00:00.000Z" }),
		]);
		const counts = getDailyCountsByDate(entries);

		expect(Object.keys(counts)).toEqual(["2026-06-10", "2026-06-11"]);
		expect(counts["2026-06-10"]?.createdAt).toBe("2026-06-10T04:00:00.000Z");
	});
});

describe("mergeDailyEntries", () => {
	it("adds new days and keeps stored measured ones untouched", () => {
		const stored = [createDailyScanEntry({ date: "2026-06-10", hours: 24 })];

		const result = mergeDailyEntries(stored, [
			createDailyScanEntry({ date: "2026-06-10", hours: 6 }),
			createDailyScanEntry({ date: "2026-06-11" }),
		]);

		expect(result.map((entry) => [entry.date, entry.hours])).toEqual([
			["2026-06-10", 24],
			["2026-06-11", 24],
		]);
	});

	it("never lets a backfilled day replace a stored window day", () => {
		const stored = [createDailyScanEntry({ date: "2026-06-10", hours: 24 })];

		const result = mergeDailyEntries(stored, [
			createDailyScanEntry({ date: "2026-06-10", hours: 0 }),
			createDailyScanEntry({ date: "2026-06-09", hours: 0 }),
		]);

		expect(result.map((entry) => [entry.date, entry.hours])).toEqual([
			["2026-06-09", 0],
			["2026-06-10", 24],
		]);
	});

	it("lets a window day take over the seeded day standing in for it", () => {
		const stored = [
			createDailyScanEntry({
				date: "2026-06-10",
				hours: 0,
				createdAt: "2026-06-10T19:00:00.000Z",
			}),
		];

		const result = mergeDailyEntries(stored, [
			createDailyScanEntry({
				date: "2026-06-10",
				hours: 24,
				createdAt: "2026-06-10T00:00:00.000Z",
			}),
		]);

		expect(result.map((entry) => [entry.date, entry.hours])).toEqual([
			["2026-06-10", 24],
		]);
		expect(result[0]?.createdAt).toBe("2026-06-10T00:00:00.000Z");
	});
});

describe("timezones in the daily rollup", () => {
	const day = "2026-06-10";
	const scannedHour = `${day}T23:00:00.000Z`;

	it("leaves the timezone fields out of a day measured before offsets existed", () => {
		const [entry] = getCompletedDailyEntries(
			createFullDay(day, 90),
			scannedHour,
		);

		expect(entry).not.toHaveProperty("timezones");
		expect(entry).not.toHaveProperty("topTimezone");
		expect(entry).not.toHaveProperty("localHours");
	});

	it("tallies PRs per offset, west to east, unknown last", () => {
		const rows = createFullDay(day, 90).map((row, hour) => ({
			...row,
			...(hour < 20 && { timezone: hour < 10 ? 1 : -5 }),
		}));
		rows.push(
			createEcosystemHealthItem({
				created_at: `${day}T05:00:00.000Z`,
				score: 10,
				timezone: 9,
			}),
			createEcosystemHealthItem({
				created_at: `${day}T05:00:00.000Z`,
				score: -1,
				timezone: 0,
			}),
			createEcosystemHealthItem({
				created_at: `${day}T05:00:00.000Z`,
				score: -1,
				timezone: 1,
			}),
		);

		const [entry] = getCompletedDailyEntries(rows, scannedHour);

		expect(entry?.timezones).toEqual({
			"-5": [10, 0, 0, 0],
			"+0": [0, 0, 0, 1],
			"+1": [10, 0, 0, 1],
			"+9": [0, 0, 1, 0],
			unknown: [4, 0, 0, 0],
		});
		expect(Object.keys(entry?.timezones ?? {})).toEqual([
			"-5",
			"+0",
			"+1",
			"+9",
			"unknown",
		]);
		// -5 and +1 tie on 10 scored PRs each; the westernmost wins.
		expect(entry?.topTimezone).toBe("-5");
	});

	it("names the offset with the most scored PRs as the top timezone", () => {
		const rows = createFullDay(day, 90).map((row, hour) => ({
			...row,
			timezone: hour < 15 ? 5 : -5,
		}));

		const [entry] = getCompletedDailyEntries(rows, scannedHour);

		expect(entry?.topTimezone).toBe("+5");
	});

	it("counts local hours only for PRs with an offset", () => {
		const rows = [
			createEcosystemHealthItem({
				created_at: `${day}T08:00:00.000Z`,
				score: 90,
				timezone: 1,
			}),
			createEcosystemHealthItem({
				created_at: `${day}T08:00:00.000Z`,
				score: 10,
			}),
			createEcosystemHealthItem({
				created_at: `${day}T23:00:00.000Z`,
				score: 10,
			}),
			createEcosystemHealthItem({
				created_at: `${day}T00:00:00.000Z`,
				score: 90,
			}),
		];

		const [entry] = getCompletedDailyEntries(rows, scannedHour);

		expect(entry?.localHours?.organic[9]).toBe(1);
		expect(entry?.localHours?.organic.reduce((a, b) => a + b)).toBe(1);
		expect(entry?.localHours?.automation.reduce((a, b) => a + b)).toBe(0);
	});

	it("writes number arrays on a single line", () => {
		const rows = createFullDay(day, 90).map((row) => ({
			...row,
			timezone: 1,
		}));
		const entries = getCompletedDailyEntries(rows, scannedHour);
		const written = stringifyDailyEntries(entries);

		expect(written).toContain('"+1": [24,0,0,0]');
		expect(written).toContain('"organic": [1,1,1,');
		expect(JSON.parse(written)).toEqual(entries);
	});

	it("writes days without offsets exactly as before", () => {
		const entries = getCompletedDailyEntries(
			createFullDay(day, 90),
			scannedHour,
		);

		expect(stringifyDailyEntries(entries)).toBe(
			`${JSON.stringify(entries, null, 2)}\n`,
		);
	});
});
