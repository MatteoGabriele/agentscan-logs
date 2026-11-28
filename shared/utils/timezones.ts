import type { ClassificationLabel } from "@unveil/identity";
import type { EcosystemHealthCategory } from "../types/ecosystem-health";
import { formatPercentage } from "./health-stats";

export const TIMEZONE_REGIONS = [
	"americas",
	"europe-africa",
	"asia-oceania",
	"unknown",
] as const;

export type TimezoneRegion = (typeof TIMEZONE_REGIONS)[number];

export const TIMEZONE_COUNT_ORDER = [
	"organic",
	"mixed",
	"automation",
	"insufficient-data",
] as const satisfies readonly ClassificationLabel[];

export type TimezoneCounts = [
	organic: number,
	mixed: number,
	automation: number,
	insufficientData: number,
];

export const UNKNOWN_OFFSET_KEY = "unknown";

const NIGHT_HOURS = 6;
const NIGHT_MIDPOINT = 5;
const MIN_ACTIVE_HOURS = 10;
const MIN_ACTIVE_DAYS = 3;
const MAX_NIGHT_SHARE = 0.1;

export function estimateUtcOffset(
	timestamps: Iterable<string | null | undefined>,
): number | undefined {
	const activeHours = new Set<string>();
	for (const timestamp of timestamps) {
		if (timestamp && timestamp.length >= 13) {
			activeHours.add(timestamp.slice(0, 13));
		}
	}

	const activeDays = new Set([...activeHours].map((hour) => hour.slice(0, 10)));
	if (
		activeHours.size < MIN_ACTIVE_HOURS ||
		activeDays.size < MIN_ACTIVE_DAYS
	) {
		return undefined;
	}

	const byHour: number[] = Array(24).fill(0);
	for (const hour of activeHours) {
		byHour[Number(hour.slice(11, 13))] += 1;
	}

	const nightAt = (start: number) =>
		Array.from(
			{ length: NIGHT_HOURS },
			(_, index) => byHour[(start + index) % 24],
		).reduce((sum, count) => sum + count, 0);

	let nightStart = 0;
	for (let start = 1; start < 24; start++) {
		if (nightAt(start) < nightAt(nightStart)) {
			nightStart = start;
		}
	}

	if (nightAt(nightStart) / activeHours.size > MAX_NIGHT_SHARE) {
		return undefined;
	}

	const utcMidpoint = nightStart + NIGHT_HOURS / 2;
	const hours =
		((((Math.round(NIGHT_MIDPOINT - utcMidpoint) + 11) % 24) + 24) % 24) - 11;

	return hours * 60;
}

export function getTimezoneRegion(
	estimate: number | undefined,
): TimezoneRegion {
	if (estimate == null || !Number.isFinite(estimate)) {
		return "unknown";
	}
	if (estimate < -60) {
		return "americas";
	}
	if (estimate < 240) {
		return "europe-africa";
	}
	return "asia-oceania";
}

export function getLocalHour(
	utcHourStart: string,
	offsetMinutes: number,
): number {
	const utcMinutes = new Date(utcHourStart).getUTCHours() * 60;
	const local = Math.floor((utcMinutes + offsetMinutes) / 60);
	return ((local % 24) + 24) % 24;
}

export function getOffsetKey(estimate: number | undefined): string {
	if (estimate == null) {
		return UNKNOWN_OFFSET_KEY;
	}
	return estimate < 0 ? String(estimate) : `+${estimate}`;
}

function estimateFromKey(key: string): number | undefined {
	return key === UNKNOWN_OFFSET_KEY ? undefined : Number(key);
}

export type RegionStats = {
	count: number;
	share: string;
	classifications: Record<
		EcosystemHealthCategory,
		{ count: number; percentage: string }
	>;
};

export type RegionBreakdown = Record<TimezoneRegion, RegionStats>;

export function getRegionBreakdown(
	timezones: Iterable<[string, TimezoneCounts]>,
): RegionBreakdown {
	const totals = Object.fromEntries(
		TIMEZONE_REGIONS.map((region) => [region, [0, 0, 0, 0]]),
	) as Record<TimezoneRegion, TimezoneCounts>;

	for (const [key, counts] of timezones) {
		const region = getTimezoneRegion(estimateFromKey(key));
		counts.forEach((count, index) => {
			totals[region][index] += count;
		});
	}

	const peopleIn = (counts: TimezoneCounts) =>
		counts[0] + counts[1] + counts[2];
	const grandTotal = TIMEZONE_REGIONS.reduce(
		(sum, region) => sum + peopleIn(totals[region]),
		0,
	);

	const percent = (part: number, whole: number) =>
		formatPercentage(whole === 0 ? 0 : (part / whole) * 100);

	return Object.fromEntries(
		TIMEZONE_REGIONS.map((region) => {
			const counts = totals[region];
			const count = peopleIn(counts);
			const stats: RegionStats = {
				count,
				share: percent(count, grandTotal),
				classifications: {
					organic: { count: counts[0], percentage: percent(counts[0], count) },
					mixed: { count: counts[1], percentage: percent(counts[1], count) },
					automation: {
						count: counts[2],
						percentage: percent(counts[2], count),
					},
				},
			};
			return [region, stats];
		}),
	) as RegionBreakdown;
}

type WithTimezones = {
	date: string;
	timezones?: Record<string, TimezoneCounts>;
	localHours?: Record<EcosystemHealthCategory, number[]>;
};

export type TimezoneSummary = {
	dates: string[];
	overall: RegionBreakdown;
	byDate: Record<string, RegionBreakdown>;
	localHours: Record<EcosystemHealthCategory, number[]>;
};

export function getTimezoneSummary(entries: WithTimezones[]): TimezoneSummary {
	const measured = entries
		.filter((entry) => entry.timezones)
		.sort((a, b) => a.date.localeCompare(b.date));

	const localHours: Record<EcosystemHealthCategory, number[]> = {
		organic: Array(24).fill(0),
		mixed: Array(24).fill(0),
		automation: Array(24).fill(0),
	};

	for (const entry of measured) {
		for (const category of Object.keys(
			localHours,
		) as EcosystemHealthCategory[]) {
			entry.localHours?.[category]?.forEach((count, hour) => {
				localHours[category][hour] += count;
			});
		}
	}

	return {
		dates: measured.map((entry) => entry.date),
		overall: getRegionBreakdown(
			measured.flatMap((entry) => Object.entries(entry.timezones ?? {})),
		),
		byDate: Object.fromEntries(
			measured.map((entry) => [
				entry.date,
				getRegionBreakdown(Object.entries(entry.timezones ?? {})),
			]),
		),
		localHours,
	};
}
