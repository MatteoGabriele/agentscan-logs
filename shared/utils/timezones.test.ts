import { describe, expect, it } from "vitest";
import {
	estimateUtcOffset,
	getLocalHour,
	getRegionBreakdown,
	getTimezoneRegion,
	getTimezoneSummary,
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
		expect(estimateUtcOffset(activity(range(7, 25)))).toBe(60);
		expect(estimateUtcOffset(activity(range(13, 31)))).toBe(-300);
		expect(estimateUtcOffset(activity(range(23, 41)))).toBe(540);
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
		[-480, "americas"],
		[-180, "americas"],
		[-120, "americas"],
		[-60, "europe-africa"],
		[60, "europe-africa"],
		[120, "europe-africa"],
		[210, "europe-africa"],
		[240, "asia-oceania"],
		[330, "asia-oceania"],
		[780, "asia-oceania"],
		[0, "europe-africa"],
		[undefined, "unknown"],
	] as const)("%s → %s", (offset, region) => {
		expect(getTimezoneRegion(offset)).toBe(region);
	});
});

describe("getLocalHour", () => {
	it("shifts the UTC hour by the offset and wraps around midnight", () => {
		expect(getLocalHour("2026-11-27T07:00:00.000Z", 60)).toBe(8);
		expect(getLocalHour("2026-11-27T02:00:00.000Z", -300)).toBe(21);
		expect(getLocalHour("2026-11-27T22:00:00.000Z", 540)).toBe(7);
		expect(getLocalHour("2026-11-27T07:00:00.000Z", 330)).toBe(12);
	});
});

describe("getRegionBreakdown", () => {
	it("folds offsets into regions and leaves insufficient data out", () => {
		const breakdown = getRegionBreakdown([
			["+60", [6, 1, 1, 5]],
			["+120", [1, 0, 1, 0]],
			["-300", [2, 0, 0, 0]],
			["+540", [0, 0, 8, 0]],
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

describe("getTimezoneSummary", () => {
	it("only reads days that carry offsets and sums their local hours", () => {
		const hours = (hour: number) =>
			Array.from({ length: 24 }, (_, index) => (index === hour ? 1 : 0));
		const summary = getTimezoneSummary([
			{
				date: "2026-11-29",
				timezones: { "+60": [1, 0, 0, 0] },
				localHours: {
					organic: hours(9),
					mixed: hours(0),
					automation: hours(3),
				},
			},
			{ date: "2026-11-27" },
			{
				date: "2026-11-28",
				timezones: { "+60": [0, 0, 1, 0] },
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
