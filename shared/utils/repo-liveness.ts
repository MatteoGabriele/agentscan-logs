/**
 * Scores how alive a repository is on a 0–10 scale, where 0 is dead and 10 is
 * very active. Three things decide it, in the order the scan cares about them:
 *
 * - volume: is there a decent amount of PR traffic at all
 * - freshness: is that traffic happening now, not weeks or months ago
 * - maintenance: is somebody on the other side merging and pushing
 *
 * Everything here is pure so the thresholds can be tested and tuned without
 * touching the network.
 */

export const LOOKBACK_DAYS = 30;

/** PRs opened per month that earns full marks on volume. */
export const VOLUME_FULL_PRS = 100;
/** PRs merged per month that earns full marks on throughput. */
export const MERGE_FULL_PRS = 50;

/**
 * Recency curves: full credit inside `grace`, then a halving every `halfLife`
 * days. A repo whose last PR landed 13 days ago keeps half of its freshness
 * points, at 23 days a quarter, and by two months it has effectively none.
 */
const PR_RECENCY = { grace: 3, halfLife: 10 };
const PUSH_RECENCY = { grace: 3, halfLife: 14 };
const MERGE_RECENCY = { grace: 5, halfLife: 14 };

const WEIGHTS = { volume: 0.4, freshness: 0.3, maintenance: 0.3 };

export type LivenessLabel =
	| "very active"
	| "active"
	| "steady"
	| "slowing"
	| "stale"
	| "dead"
	| "archived";

export interface PrSample {
	createdAt: string;
	mergedAt: string | null;
	closedAt: string | null;
}

export interface RepoActivity {
	repo: string;
	isArchived: boolean;
	isDisabled: boolean;
	/** Last push to any branch — the "is anyone still working here" signal. */
	pushedAt: string | null;
	openPrCount: number;
	stars: number;
	/** PRs newest-created first, capped by the fetch page size. */
	createdPrs: PrSample[];
	/** True when the created-PR sample filled up, so older PRs exist beyond it. */
	createdPrsTruncated: boolean;
	/** Merge timestamps, newest first, capped by the fetch page size. */
	mergedAt: string[];
	/** True when the merged-PR sample filled up. */
	mergedPrsTruncated: boolean;
}

export interface LivenessBreakdown {
	/** Each part is itself a 0–10 score, so a low column is easy to spot. */
	volume: number;
	freshness: number;
	maintenance: number;
}

export interface RepoLiveness {
	repo: string;
	score: number;
	label: LivenessLabel;
	prsPerMonth: number;
	mergedPerMonth: number;
	/** Share of decided PRs in the window that were merged rather than dropped. */
	mergeRate: number | null;
	openPrCount: number;
	stars: number;
	daysSinceLastPr: number | null;
	daysSinceLastMerge: number | null;
	daysSincePush: number | null;
	breakdown: LivenessBreakdown;
	notes: string[];
}

function daysSince(timestamp: string | null | undefined, now: Date) {
	if (!timestamp) {
		return null;
	}
	const then = new Date(timestamp).getTime();
	if (Number.isNaN(then)) {
		return null;
	}
	return Math.max(0, (now.getTime() - then) / 86_400_000);
}

/** 1 inside the grace period, then halving every `halfLife` days. */
export function recencyScore(
	days: number | null,
	{ grace, halfLife }: { grace: number; halfLife: number },
) {
	if (days == null) {
		return 0;
	}
	if (days <= grace) {
		return 1;
	}
	return 2 ** (-(days - grace) / halfLife);
}

/**
 * Log scale, so the gap between 1 and 10 PRs a month counts for more than the
 * gap between 90 and 100. Anything at or past `full` scores 1.
 */
export function logScore(value: number, full: number) {
	if (value <= 0) {
		return 0;
	}
	return Math.min(1, Math.log10(value + 1) / Math.log10(full + 1));
}

/**
 * PRs per lookback window from a newest-first sample. When the sample is
 * truncated but does not even reach back to the start of the window, the repo
 * is busier than the page size can show, so the rate is extrapolated from the
 * span the sample does cover.
 */
export function monthlyRate(
	timestamps: string[],
	truncated: boolean,
	now: Date,
	lookbackDays = LOOKBACK_DAYS,
) {
	const times = timestamps
		.map((value) => new Date(value).getTime())
		.filter((value) => !Number.isNaN(value))
		.sort((a, b) => b - a);

	if (!times.length) {
		return 0;
	}

	const windowStart = now.getTime() - lookbackDays * 86_400_000;
	const inWindow = times.filter((time) => time >= windowStart).length;
	const oldest = times[times.length - 1];

	if (!truncated || oldest <= windowStart) {
		return inWindow;
	}

	// Sample ran out inside the window: measure the rate over the span it covers.
	const spanDays = Math.max((now.getTime() - oldest) / 86_400_000, 1);
	return (times.length / spanDays) * lookbackDays;
}

function labelFor(score: number): LivenessLabel {
	if (score >= 8.5) {
		return "very active";
	} else if (score >= 7) {
		return "active";
	} else if (score >= 5) {
		return "steady";
	} else if (score >= 3) {
		return "slowing";
	} else if (score >= 1.5) {
		return "stale";
	} else {
		return "dead";
	}
}

export function scoreRepoLiveness(
	activity: RepoActivity,
	now = new Date(),
	lookbackDays = LOOKBACK_DAYS,
): RepoLiveness {
	const notes: string[] = [];
	const windowStart = now.getTime() - lookbackDays * 86_400_000;

	const prsPerMonth = monthlyRate(
		activity.createdPrs.map((pr) => pr.createdAt),
		activity.createdPrsTruncated,
		now,
		lookbackDays,
	);
	const mergedPerMonth = monthlyRate(
		activity.mergedAt,
		activity.mergedPrsTruncated,
		now,
		lookbackDays,
	);

	const daysSinceLastPr = daysSince(activity.createdPrs[0]?.createdAt, now);
	const daysSinceLastMerge = daysSince(activity.mergedAt[0], now);
	const daysSincePush = daysSince(activity.pushedAt, now);

	// Merged versus abandoned, over the PRs opened in the window that already
	// got an answer. Still-open PRs are undecided and stay out of it.
	const decided = activity.createdPrs.filter((pr) => {
		const created = new Date(pr.createdAt).getTime();
		return created >= windowStart && (pr.mergedAt || pr.closedAt);
	});
	const merged = decided.filter((pr) => pr.mergedAt).length;
	const mergeRate = decided.length ? merged / decided.length : null;

	const volume = logScore(prsPerMonth, VOLUME_FULL_PRS);
	const freshness =
		0.65 * recencyScore(daysSinceLastPr, PR_RECENCY) +
		0.35 * recencyScore(daysSincePush, PUSH_RECENCY);
	const maintenance =
		0.45 * logScore(mergedPerMonth, MERGE_FULL_PRS) +
		0.35 * recencyScore(daysSinceLastMerge, MERGE_RECENCY) +
		// No decided PRs yet is neither good nor bad, so it sits in the middle.
		0.2 * (mergeRate ?? 0.5);

	let score =
		10 *
		(WEIGHTS.volume * volume +
			WEIGHTS.freshness * freshness +
			WEIGHTS.maintenance * maintenance);

	if (
		activity.createdPrsTruncated &&
		prsPerMonth > activity.createdPrs.length
	) {
		notes.push("PR rate extrapolated from a full page");
	}
	if (!activity.createdPrs.length) {
		notes.push("no pull requests found");
	}
	if (activity.isArchived) {
		notes.push("archived");
	}
	if (activity.isDisabled) {
		notes.push("disabled");
	}

	// An archived or disabled repo cannot take contributions, whatever its
	// history looks like.
	if (activity.isArchived || activity.isDisabled) {
		score = 0;
	}

	const round1 = (value: number) => Math.round(value * 10) / 10;

	return {
		repo: activity.repo,
		score: round1(score),
		label:
			activity.isArchived || activity.isDisabled ? "archived" : labelFor(score),
		prsPerMonth: round1(prsPerMonth),
		mergedPerMonth: round1(mergedPerMonth),
		mergeRate,
		openPrCount: activity.openPrCount,
		stars: activity.stars,
		daysSinceLastPr: daysSinceLastPr == null ? null : round1(daysSinceLastPr),
		daysSinceLastMerge:
			daysSinceLastMerge == null ? null : round1(daysSinceLastMerge),
		daysSincePush: daysSincePush == null ? null : round1(daysSincePush),
		breakdown: {
			volume: round1(volume * 10),
			freshness: round1(freshness * 10),
			maintenance: round1(maintenance * 10),
		},
		notes,
	};
}
