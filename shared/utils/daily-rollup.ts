import type { IdentityClassification } from "@unveil/identity";
import type {
	EcosystemHealthCategory,
	EcosystemHealthItem,
	PrStatus,
} from "../types/ecosystem-health";
import type { GetClassificationStatsByDateResults } from "./count-classification-by-date";
import {
	applyClassificationPercentages,
	CLASSIFICATION_CATEGORIES,
	createEmptyClassificationStats,
} from "./count-classification-by-date";
import { classifyByScore, formatPercentage } from "./health-stats";

// Lines changed by the PRs counted. Only present when every one of them was
// sized: a partial sum would read as a smaller number, not a missing one.
type LineCounts = {
	additions?: number;
	deletions?: number;
};

export type DailyClassificationCounts = LineCounts & {
	count: number;
	bountyCount: number;
	prStatusCounts: Record<PrStatus, number>;
};

export type DailyScanEntry = LineCounts & {
	date: string;
	createdAt: string;
	hours: number;
	classifications: Record<IdentityClassification, DailyClassificationCounts>;
};

type DailyScanBucket = Pick<DailyScanEntry, "createdAt" | "classifications"> & {
	hours: Set<string>;
};

function createClassificationCounts(): DailyClassificationCounts {
	return {
		count: 0,
		bountyCount: 0,
		prStatusCounts: { open: 0, closed: 0, merged: 0 },
	};
}

function createClassifications(): DailyScanEntry["classifications"] {
	return {
		organic: createClassificationCounts(),
		mixed: createClassificationCounts(),
		automation: createClassificationCounts(),
		"insufficient-data": createClassificationCounts(),
	};
}

function getDayStart(date: string): string {
	return `${date}T00:00:00.000Z`;
}

function getDate(timestamp: string): string {
	return timestamp.slice(0, 10);
}

function collectBucketsByDate(
	results: EcosystemHealthItem[],
): Map<string, DailyScanBucket> {
	const bucketsByDate = new Map<string, DailyScanBucket>();

	results.forEach((result) => {
		const date = getDate(result.created_at);
		const bucket = bucketsByDate.get(date) ?? {
			createdAt: result.created_at,
			hours: new Set<string>(),
			classifications: createClassifications(),
		};
		const counts = bucket.classifications[classifyByScore(result.score)];
		const isComplete = counts.count === 0 || counts.additions != null;

		if (isComplete && result.additions != null && result.deletions != null) {
			counts.additions = (counts.additions ?? 0) + result.additions;
			counts.deletions = (counts.deletions ?? 0) + result.deletions;
		} else {
			delete counts.additions;
			delete counts.deletions;
		}

		counts.count += 1;
		counts.bountyCount += result.is_bounty ? 1 : 0;
		counts.prStatusCounts[result.pr_status] += 1;

		bucket.hours.add(result.created_at);
		bucket.createdAt =
			result.created_at < bucket.createdAt
				? result.created_at
				: bucket.createdAt;

		bucketsByDate.set(date, bucket);
	});

	return bucketsByDate;
}

// The whole day across every classification, insufficient data included.
function sumLineCounts(
	classifications: DailyScanEntry["classifications"],
): LineCounts {
	const counted = Object.values(classifications).filter(
		(counts) => counts.count > 0,
	);

	if (
		counted.length === 0 ||
		counted.some((counts) => counts.additions == null)
	) {
		return {};
	}

	return {
		additions: counted.reduce(
			(sum, counts) => sum + (counts.additions ?? 0),
			0,
		),
		deletions: counted.reduce(
			(sum, counts) => sum + (counts.deletions ?? 0),
			0,
		),
	};
}

function toDailyEntry(
	date: string,
	bucket: DailyScanBucket,
	hours: number,
): DailyScanEntry {
	return {
		date,
		createdAt: bucket.createdAt,
		hours,
		...sumLineCounts(bucket.classifications),
		classifications: bucket.classifications,
	};
}

function byDate(a: DailyScanEntry, b: DailyScanEntry): number {
	return a.date.localeCompare(b.date);
}

function getDayEnd(date: string): string {
	return `${date}T23:00:00.000Z`;
}

// An hour with no PR writes no row, so the rows alone cannot say how far the
// scan got. The run passes in the hour it just scanned instead, and a day is
// done once that hour reaches its last one, 23:00.
function isFullyScanned(date: string, scannedHour: string): boolean {
	return scannedHour >= getDayEnd(date);
}

// The window only keeps so many hours. A day that has lost its first one is
// half gone, so it is left out.
function isFullyRetained(date: string, firstBucket: string): boolean {
	return firstBucket <= getDayStart(date);
}

// The days that are fully scanned and still fully inside the window.
export function getCompletedDailyEntries(
	results: EcosystemHealthItem[],
	scannedHour: string,
): DailyScanEntry[] {
	const firstBucket = results
		.map((result) => result.created_at)
		.sort()
		.at(0);

	if (!firstBucket) {
		return [];
	}

	return [...collectBucketsByDate(results).entries()]
		.filter(
			([date]) =>
				isFullyRetained(date, firstBucket) && isFullyScanned(date, scannedHour),
		)
		.map(([date, bucket]) => toDailyEntry(date, bucket, bucket.hours.size))
		.sort(byDate);
}

export function getDailyCountsByDate(
	entries: DailyScanEntry[],
): GetClassificationStatsByDateResults {
	const result: GetClassificationStatsByDateResults = {};

	[...entries].sort(byDate).forEach((entry) => {
		const counts = createEmptyClassificationStats();

		CLASSIFICATION_CATEGORIES.forEach((category) => {
			counts[category].count = entry.classifications[category].count;
		});

		counts.createdAt = entry.createdAt;
		result[entry.date] = applyClassificationPercentages(counts);
	});

	return result;
}

export function getDailyHealthStats(
	entries: DailyScanEntry[],
): Record<
	EcosystemHealthCategory,
	{ count: number; percentage: string }
> | null {
	const counts: Record<EcosystemHealthCategory, number> = {
		organic: 0,
		mixed: 0,
		automation: 0,
	};

	entries.forEach((entry) => {
		CLASSIFICATION_CATEGORIES.forEach((category) => {
			counts[category] += entry.classifications[category].count;
		});
	});

	const total = CLASSIFICATION_CATEGORIES.reduce(
		(sum, category) => sum + counts[category],
		0,
	);

	if (total === 0) {
		return null;
	}

	return {
		organic: {
			count: counts.organic,
			percentage: formatPercentage((counts.organic / total) * 100),
		},
		mixed: {
			count: counts.mixed,
			percentage: formatPercentage((counts.mixed / total) * 100),
		},
		automation: {
			count: counts.automation,
			percentage: formatPercentage((counts.automation / total) * 100),
		},
	};
}

// A seeded day (`hours: 0`) is one snapshot standing in for the whole day, so
// a measured day replaces it. Otherwise the stored day wins and reruns change
// nothing.
function isReplacing(stored: DailyScanEntry, entry: DailyScanEntry): boolean {
	return stored.hours === 0 && entry.hours > 0;
}

export function mergeDailyEntries(
	stored: DailyScanEntry[],
	entries: DailyScanEntry[],
): DailyScanEntry[] {
	const byDateEntries = new Map(stored.map((entry) => [entry.date, entry]));

	entries.forEach((entry) => {
		const current = byDateEntries.get(entry.date);

		if (!current || isReplacing(current, entry)) {
			byDateEntries.set(entry.date, entry);
		}
	});

	return [...byDateEntries.values()].sort(byDate);
}
