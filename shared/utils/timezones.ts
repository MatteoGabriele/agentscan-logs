import type { ClassificationLabel } from "@unveil/identity";
import type {
	EcosystemHealthCategory,
	EcosystemHealthItem,
} from "../types/ecosystem-health";
import { CLASSIFICATION_CATEGORIES } from "./count-classification-by-date";
import { classifyByScore, formatPercentage } from "./health-stats";

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

export type LocalHours = Record<EcosystemHealthCategory, number[]>;

export const UNKNOWN_OFFSET_KEY = "unknown";

const HOURS_PER_DAY = 24;
const WESTERNMOST_OFFSET = -11;
const AMERICAS_EASTERNMOST_OFFSET = -2;
const EUROPE_AFRICA_EASTERNMOST_OFFSET = 3;

const MIN_ACTIVE_HOURS = 10;
const MIN_ACTIVE_DAYS = 3;
const SLEEP_HOURS = 6;
const TYPICAL_LOCAL_SLEEP_MIDPOINT = 5;
const MAX_SHARE_ACTIVE_WHILE_ASLEEP = 0.1;

function wrapHour(hour: number): number {
	return ((hour % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
}

function wrapOffset(offset: number): number {
	return wrapHour(offset - WESTERNMOST_OFFSET) + WESTERNMOST_OFFSET;
}

function toUtcHourKey(timestamp: string): string {
	return timestamp.slice(0, 13);
}

function getDayOfHourKey(hourKey: string): string {
	return hourKey.slice(0, 10);
}

function getHourOfHourKey(hourKey: string): number {
	return Number(hourKey.slice(11, 13));
}

function collectActiveUtcHours(
	timestamps: Iterable<string | null | undefined>,
): Set<string> {
	const activeHours = new Set<string>();

	for (const timestamp of timestamps) {
		if (timestamp && timestamp.length >= 13) {
			activeHours.add(toUtcHourKey(timestamp));
		}
	}

	return activeHours;
}

function hasEnoughActivity(activeHours: Set<string>): boolean {
	const activeDays = new Set([...activeHours].map(getDayOfHourKey));

	return (
		activeHours.size >= MIN_ACTIVE_HOURS && activeDays.size >= MIN_ACTIVE_DAYS
	);
}

function countActivityPerUtcHour(activeHours: Set<string>): number[] {
	const activityPerHour: number[] = Array(HOURS_PER_DAY).fill(0);

	for (const hourKey of activeHours) {
		activityPerHour[getHourOfHourKey(hourKey)] += 1;
	}

	return activityPerHour;
}

function countActivityWhileAsleep(
	activityPerHour: number[],
	sleepStart: number,
): number {
	let activity = 0;

	for (let hour = sleepStart; hour < sleepStart + SLEEP_HOURS; hour++) {
		activity += activityPerHour[wrapHour(hour)];
	}

	return activity;
}

function findQuietestSleepStart(activityPerHour: number[]): number {
	let quietestStart = 0;

	for (let start = 1; start < HOURS_PER_DAY; start++) {
		if (
			countActivityWhileAsleep(activityPerHour, start) <
			countActivityWhileAsleep(activityPerHour, quietestStart)
		) {
			quietestStart = start;
		}
	}

	return quietestStart;
}

export function estimateUtcOffset(
	timestamps: Iterable<string | null | undefined>,
): number | undefined {
	const activeHours = collectActiveUtcHours(timestamps);

	if (!hasEnoughActivity(activeHours)) {
		return undefined;
	}

	const activityPerHour = countActivityPerUtcHour(activeHours);
	const sleepStart = findQuietestSleepStart(activityPerHour);
	const shareActiveWhileAsleep =
		countActivityWhileAsleep(activityPerHour, sleepStart) / activeHours.size;

	if (shareActiveWhileAsleep > MAX_SHARE_ACTIVE_WHILE_ASLEEP) {
		return undefined;
	}

	const utcSleepMidpoint = sleepStart + SLEEP_HOURS / 2;

	return wrapOffset(
		Math.round(TYPICAL_LOCAL_SLEEP_MIDPOINT - utcSleepMidpoint),
	);
}

export function getTimezoneRegion(offset: number | undefined): TimezoneRegion {
	if (offset == null || !Number.isFinite(offset)) {
		return "unknown";
	}
	if (offset <= AMERICAS_EASTERNMOST_OFFSET) {
		return "americas";
	}
	if (offset <= EUROPE_AFRICA_EASTERNMOST_OFFSET) {
		return "europe-africa";
	}
	return "asia-oceania";
}

export function getLocalHour(utcHourStart: string, offset: number): number {
	return wrapHour(new Date(utcHourStart).getUTCHours() + offset);
}

export function getOffsetKey(offset: number | undefined): string {
	if (offset == null) {
		return UNKNOWN_OFFSET_KEY;
	}
	return offset < 0 ? String(offset) : `+${offset}`;
}

function getOffsetFromKey(key: string): number | undefined {
	return key === UNKNOWN_OFFSET_KEY ? undefined : Number(key);
}

export function createTimezoneCounts(): TimezoneCounts {
	return [0, 0, 0, 0];
}

export function addToTimezoneCounts(
	counts: TimezoneCounts,
	classification: ClassificationLabel,
): void {
	counts[TIMEZONE_COUNT_ORDER.indexOf(classification)] += 1;
}

function countScoredPrs([organic, mixed, automation]: TimezoneCounts): number {
	return organic + mixed + automation;
}

type TimezoneCandidate = { key: string; scoredPrs: number };

function byMostScoredPrsThenWesternmost(
	a: TimezoneCandidate,
	b: TimezoneCandidate,
): number {
	return b.scoredPrs - a.scoredPrs || Number(a.key) - Number(b.key);
}

export function getTopTimezone(
	timezones: Iterable<[string, TimezoneCounts]>,
): string | undefined {
	const [top] = [...timezones]
		.filter(([key]) => key !== UNKNOWN_OFFSET_KEY)
		.map(([key, counts]) => ({ key, scoredPrs: countScoredPrs(counts) }))
		.filter(({ scoredPrs }) => scoredPrs > 0)
		.sort(byMostScoredPrsThenWesternmost);

	return top?.key;
}

type TimezonedResult = Pick<
	EcosystemHealthItem,
	"created_at" | "score" | "timezone"
>;

function countTimezonesPerScanTime(
	results: TimezonedResult[],
): Map<string, Map<string, TimezoneCounts>> {
	const timezonesPerScanTime = new Map<string, Map<string, TimezoneCounts>>();

	for (const result of results) {
		const timezones =
			timezonesPerScanTime.get(result.created_at) ??
			new Map<string, TimezoneCounts>();
		const key = getOffsetKey(result.timezone);
		const counts = timezones.get(key) ?? createTimezoneCounts();

		addToTimezoneCounts(counts, classifyByScore(result.score));
		timezones.set(key, counts);
		timezonesPerScanTime.set(result.created_at, timezones);
	}

	return timezonesPerScanTime;
}

export function getTopTimezoneByScanTime(
	results: TimezonedResult[],
): Map<string, string> {
	const topTimezones = new Map<string, string>();

	for (const [scanTime, timezones] of countTimezonesPerScanTime(results)) {
		const topTimezone = getTopTimezone(timezones);

		if (topTimezone) {
			topTimezones.set(scanTime, topTimezone);
		}
	}

	return topTimezones;
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

function toPercentage(part: number, whole: number): string {
	return formatPercentage(whole === 0 ? 0 : (part / whole) * 100);
}

function sumCountsPerRegion(
	timezones: Iterable<[string, TimezoneCounts]>,
): Record<TimezoneRegion, TimezoneCounts> {
	const countsPerRegion = Object.fromEntries(
		TIMEZONE_REGIONS.map((region) => [region, createTimezoneCounts()]),
	) as Record<TimezoneRegion, TimezoneCounts>;

	for (const [key, counts] of timezones) {
		const regionCounts =
			countsPerRegion[getTimezoneRegion(getOffsetFromKey(key))];

		counts.forEach((count, index) => {
			regionCounts[index] += count;
		});
	}

	return countsPerRegion;
}

function describeRegion(
	counts: TimezoneCounts,
	allScoredPrs: number,
): RegionStats {
	const [organic, mixed, automation] = counts;
	const scoredPrs = countScoredPrs(counts);
	const withPercentage = (count: number) => ({
		count,
		percentage: toPercentage(count, scoredPrs),
	});

	return {
		count: scoredPrs,
		share: toPercentage(scoredPrs, allScoredPrs),
		classifications: {
			organic: withPercentage(organic),
			mixed: withPercentage(mixed),
			automation: withPercentage(automation),
		},
	};
}

export function getRegionBreakdown(
	timezones: Iterable<[string, TimezoneCounts]>,
): RegionBreakdown {
	const countsPerRegion = sumCountsPerRegion(timezones);
	const allScoredPrs = TIMEZONE_REGIONS.reduce(
		(sum, region) => sum + countScoredPrs(countsPerRegion[region]),
		0,
	);

	return Object.fromEntries(
		TIMEZONE_REGIONS.map((region) => [
			region,
			describeRegion(countsPerRegion[region], allScoredPrs),
		]),
	) as RegionBreakdown;
}

export function createEmptyLocalHours(): LocalHours {
	return {
		organic: Array(HOURS_PER_DAY).fill(0),
		mixed: Array(HOURS_PER_DAY).fill(0),
		automation: Array(HOURS_PER_DAY).fill(0),
	};
}

type DayWithTimezones = {
	date: string;
	timezones?: Record<string, TimezoneCounts>;
	localHours?: LocalHours;
};

export type TimezoneSummary = {
	dates: string[];
	overall: RegionBreakdown;
	byDate: Record<string, RegionBreakdown>;
	localHours: LocalHours;
};

function sumLocalHours(days: DayWithTimezones[]): LocalHours {
	const localHours = createEmptyLocalHours();

	for (const day of days) {
		for (const category of CLASSIFICATION_CATEGORIES) {
			day.localHours?.[category]?.forEach((count, hour) => {
				localHours[category][hour] += count;
			});
		}
	}

	return localHours;
}

function getTimezoneEntries(day: DayWithTimezones): [string, TimezoneCounts][] {
	return Object.entries(day.timezones ?? {});
}

export function getTimezoneSummary(days: DayWithTimezones[]): TimezoneSummary {
	const measuredDays = days
		.filter((day) => day.timezones)
		.sort((a, b) => a.date.localeCompare(b.date));

	return {
		dates: measuredDays.map((day) => day.date),
		overall: getRegionBreakdown(measuredDays.flatMap(getTimezoneEntries)),
		byDate: Object.fromEntries(
			measuredDays.map((day) => [
				day.date,
				getRegionBreakdown(getTimezoneEntries(day)),
			]),
		),
		localHours: sumLocalHours(measuredDays),
	};
}
