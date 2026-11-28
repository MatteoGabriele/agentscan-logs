import { describe, expect, it } from "vitest";
import {
	estimateUtcOffset,
	getLocalHour,
	getRegionBreakdown,
	getTimezoneRegion,
	getTimezoneSummary,
	getTopTimezone,
	getTopTimezoneByScanTime,
} from "./timezones";

function activity(hours: number[], days = 10): string[] {
	return Array.from({ length: days }, (_, day) =>
		hours.map(
			(hour) =>
				`2026-11-${String(day + 1).padStart(2, "0")}T${String(hour).padStart(2, "0")}:15:00Z`,
		),
	).flat();
}

const range = (from: number, to: number) =>
	Array.from({ length: to - from }, (_, index) => (from + index) % 24);

describe("estimateUtcOffset", () => {
	it("places a night of 02:00–08:00 local on the UTC clock", () => {
		expect(estimateUtcOffset(activity(range(8, 26)))).toBe(0);
		expect(estimateUtcOffset(activity(range(7, 25)))).toBe(1);
		expect(estimateUtcOffset(activity(range(13, 31)))).toBe(-5);
		expect(estimateUtcOffset(activity(range(23, 41)))).toBe(9);
	});

	it("gives no estimate for an account with no quiet hours", () => {
		expect(estimateUtcOffset(activity(range(0, 24)))).toBeUndefined();
	});

	it("gives up on too little activity", () => {
		expect(estimateUtcOffset(activity([9, 10, 11], 2))).toBeUndefined();
		expect(estimateUtcOffset([])).toBeUndefined();
	});

	it("counts a burst inside one hour once", () => {
		const burst = Array.from({ length: 200 }, () => "2026-11-05T04:00:00Z");

		expect(estimateUtcOffset([...activity(range(8, 26)), ...burst])).toBe(0);
	});
});

describe("getTimezoneRegion", () => {
	it.each([
		[-8, "americas"],
		[-3, "americas"],
		[-2, "americas"],
		[-1, "europe-africa"],
		[1, "europe-africa"],
		[2, "europe-africa"],
		[3, "europe-africa"],
		[4, "asia-oceania"],
		[5, "asia-oceania"],
		[12, "asia-oceania"],
		[0, "europe-africa"],
		[undefined, "unknown"],
	] as const)("%s → %s", (offset, region) => {
		expect(getTimezoneRegion(offset)).toBe(region);
	});
});

describe("getLocalHour", () => {
	it("shifts the UTC hour by the offset and wraps around midnight", () => {
		expect(getLocalHour("2026-11-27T07:00:00.000Z", 1)).toBe(8);
		expect(getLocalHour("2026-11-27T02:00:00.000Z", -5)).toBe(21);
		expect(getLocalHour("2026-11-27T22:00:00.000Z", 9)).toBe(7);
		expect(getLocalHour("2026-11-27T07:00:00.000Z", 12)).toBe(19);
	});
});

describe("getRegionBreakdown", () => {
	it("folds offsets into regions and leaves insufficient data out", () => {
		const breakdown = getRegionBreakdown([
			["+1", [6, 1, 1, 5]],
			["+2", [1, 0, 1, 0]],
			["-5", [2, 0, 0, 0]],
			["+9", [0, 0, 8, 0]],
			["unknown", [0, 0, 0, 3]],
		]);

		expect(breakdown["europe-africa"]).toEqual({
			count: 10,
			share: "50.0",
			classifications: {
				organic: { count: 7, percentage: "70.0" },
				mixed: { count: 1, percentage: "10.0" },
				automation: { count: 2, percentage: "20.0" },
			},
		});
		expect(
			breakdown["asia-oceania"].classifications.automation.percentage,
		).toBe("100.0");
		expect(breakdown.americas.share).toBe("10.0");
		expect(breakdown.unknown.count).toBe(0);
	});
});

describe("getTopTimezone", () => {
	it("picks the offset with the most scored PRs, ignoring unknown", () => {
		expect(
			getTopTimezone([
				["-5", [2, 1, 0, 0]],
				["+1", [1, 1, 1, 9]],
				["+5", [4, 0, 0, 0]],
				["unknown", [50, 0, 0, 0]],
			]),
		).toBe("+5");
	});

	it("breaks a tie toward the westernmost offset", () => {
		expect(
			getTopTimezone([
				["+1", [2, 0, 0, 0]],
				["-5", [1, 1, 0, 0]],
			]),
		).toBe("-5");
	});

	it("returns undefined when no scored PR has an offset", () => {
		expect(
			getTopTimezone([
				["+1", [0, 0, 0, 4]],
				["unknown", [3, 0, 0, 0]],
			]),
		).toBeUndefined();
	});
});

describe("getTopTimezoneByScanTime", () => {
	it("finds the top offset of each scan time on its own", () => {
		const first = "2026-11-01T10:00:00.000Z";
		const second = "2026-11-01T11:00:00.000Z";
		const third = "2026-11-01T12:00:00.000Z";

		const tops = getTopTimezoneByScanTime([
			{ created_at: first, score: 90, timezone: 1 },
			{ created_at: first, score: 10, timezone: 1 },
			{ created_at: first, score: 90, timezone: -5 },
			{ created_at: second, score: 90, timezone: 9 },
			{ created_at: second, score: -1, timezone: 1 },
			{ created_at: second, score: -1, timezone: 1 },
			{ created_at: third, score: 90 },
		]);

		expect(Object.fromEntries(tops)).toEqual({
			[first]: "+1",
			[second]: "+9",
		});
	});
});

describe("getTimezoneSummary", () => {
	it("only reads days that carry offsets and sums their local hours", () => {
		const hours = (hour: number) =>
			Array.from({ length: 24 }, (_, index) => (index === hour ? 1 : 0));
		const summary = getTimezoneSummary([
			{
				date: "2026-11-29",
				timezones: { "+1": [1, 0, 0, 0] },
				localHours: {
					organic: hours(9),
					mixed: hours(0),
					automation: hours(3),
				},
			},
			{ date: "2026-11-27" },
			{
				date: "2026-11-28",
				timezones: { "+1": [0, 0, 1, 0] },
				localHours: {
					organic: hours(9),
					mixed: hours(0),
					automation: hours(4),
				},
			},
		]);

		expect(summary.dates).toEqual(["2026-11-28", "2026-11-29"]);
		expect(summary.overall["europe-africa"].classifications.automation).toEqual(
			{ count: 1, percentage: "50.0" },
		);
		expect(summary.localHours.organic[9]).toBe(2);
		expect(summary.localHours.automation[3]).toBe(1);
		expect(summary.localHours.automation[4]).toBe(1);
	});
});
