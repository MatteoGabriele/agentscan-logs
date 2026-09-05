import { describe, expect, it } from "vitest";
import type { PrSample, RepoActivity } from "./repo-liveness";
import {
	logScore,
	monthlyRate,
	recencyScore,
	scoreRepoLiveness,
} from "./repo-liveness";

const NOW = new Date("2026-09-05T12:00:00Z");

function daysAgo(days: number) {
	return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function prs(spec: { created: number; merged?: number; closed?: number }[]) {
	return spec.map<PrSample>(({ created, merged, closed }) => ({
		createdAt: daysAgo(created),
		mergedAt: merged == null ? null : daysAgo(merged),
		closedAt:
			closed == null
				? merged == null
					? null
					: daysAgo(merged)
				: daysAgo(closed),
	}));
}

function activity(overrides: Partial<RepoActivity> = {}): RepoActivity {
	return {
		repo: "acme/widget",
		isArchived: false,
		isDisabled: false,
		pushedAt: daysAgo(0.2),
		openPrCount: 10,
		stars: 1000,
		createdPrs: [],
		createdPrsTruncated: false,
		mergedAt: [],
		mergedPrsTruncated: false,
		...overrides,
	};
}

describe("recencyScore", () => {
	it("gives full credit inside the grace period", () => {
		expect(recencyScore(0, { grace: 3, halfLife: 10 })).toBe(1);
		expect(recencyScore(3, { grace: 3, halfLife: 10 })).toBe(1);
	});

	it("halves once per half-life past the grace period", () => {
		expect(recencyScore(13, { grace: 3, halfLife: 10 })).toBeCloseTo(0.5);
		expect(recencyScore(23, { grace: 3, halfLife: 10 })).toBeCloseTo(0.25);
	});

	it("scores nothing when the event never happened", () => {
		expect(recencyScore(null, { grace: 3, halfLife: 10 })).toBe(0);
	});
});

describe("logScore", () => {
	it("caps at the full-marks value", () => {
		expect(logScore(100, 100)).toBe(1);
		expect(logScore(500, 100)).toBe(1);
	});

	it("rewards the low end more than the high end", () => {
		const lowGain = logScore(10, 100) - logScore(1, 100);
		const highGain = logScore(100, 100) - logScore(90, 100);
		expect(lowGain).toBeGreaterThan(highGain);
	});

	it("is zero with no activity", () => {
		expect(logScore(0, 100)).toBe(0);
	});
});

describe("monthlyRate", () => {
	it("counts the events inside the window when the sample reaches back", () => {
		const timestamps = [daysAgo(1), daysAgo(10), daysAgo(29), daysAgo(45)];
		expect(monthlyRate(timestamps, false, NOW)).toBe(3);
	});

	it("extrapolates when a truncated sample stops inside the window", () => {
		// 100 PRs over the last 10 days is 300 a month.
		const timestamps = Array.from({ length: 100 }, (_, index) =>
			daysAgo((index / 99) * 10),
		);
		expect(monthlyRate(timestamps, true, NOW)).toBeCloseTo(300, 0);
	});

	it("does not extrapolate a truncated sample that covers the window", () => {
		const timestamps = [daysAgo(1), daysAgo(2), daysAgo(60)];
		expect(monthlyRate(timestamps, true, NOW)).toBe(2);
	});

	it("is zero with no events", () => {
		expect(monthlyRate([], false, NOW)).toBe(0);
	});
});

describe("scoreRepoLiveness", () => {
	it("scores a busy, well maintained repo near the top", () => {
		const created = Array.from({ length: 100 }, (_, index) => ({
			created: (index / 99) * 12,
			merged: (index / 99) * 12,
		}));
		const result = scoreRepoLiveness(
			activity({
				createdPrs: prs(created),
				createdPrsTruncated: true,
				mergedAt: created.map((pr) => daysAgo(pr.merged)),
				mergedPrsTruncated: true,
			}),
			NOW,
		);

		expect(result.score).toBeGreaterThanOrEqual(9);
		expect(result.label).toBe("very active");
	});

	it("scores a repo with no activity at all as dead", () => {
		const result = scoreRepoLiveness(activity({ pushedAt: daysAgo(400) }), NOW);

		expect(result.score).toBeLessThan(1.5);
		expect(result.label).toBe("dead");
		expect(result.notes).toContain("no pull requests found");
	});

	it("marks a repo stale when the PRs stopped months ago", () => {
		const result = scoreRepoLiveness(
			activity({
				pushedAt: daysAgo(120),
				createdPrs: prs([
					{ created: 120, merged: 119 },
					{ created: 140, merged: 139 },
				]),
				mergedAt: [daysAgo(119), daysAgo(139)],
			}),
			NOW,
		);

		expect(result.score).toBeLessThan(3);
		expect(result.breakdown.freshness).toBeLessThan(1);
		expect(result.daysSinceLastPr).toBeCloseTo(120, 0);
	});

	it("ranks a fresh trickle above a busy repo that went quiet", () => {
		const fresh = scoreRepoLiveness(
			activity({
				createdPrs: prs([
					{ created: 1, merged: 0.5 },
					{ created: 4, merged: 3 },
					{ created: 12, merged: 11 },
				]),
				mergedAt: [daysAgo(0.5), daysAgo(3), daysAgo(11)],
			}),
			NOW,
		);
		const quiet = scoreRepoLiveness(
			activity({
				pushedAt: daysAgo(70),
				createdPrs: prs(
					Array.from({ length: 60 }, (_, index) => ({
						created: 70 + index,
						merged: 69 + index,
					})),
				),
				mergedAt: Array.from({ length: 60 }, (_, index) => daysAgo(69 + index)),
			}),
			NOW,
		);

		expect(fresh.score).toBeGreaterThan(quiet.score);
	});

	it("zeroes an archived repo however lively its history", () => {
		const created = Array.from({ length: 50 }, (_, index) => ({
			created: index / 4,
			merged: index / 4,
		}));
		const result = scoreRepoLiveness(
			activity({
				isArchived: true,
				createdPrs: prs(created),
				mergedAt: created.map((pr) => daysAgo(pr.merged)),
			}),
			NOW,
		);

		expect(result.score).toBe(0);
		expect(result.label).toBe("archived");
		expect(result.notes).toContain("archived");
	});

	it("penalises a repo where nothing gets merged", () => {
		const spec = Array.from({ length: 20 }, (_, index) => ({
			created: index,
			closed: index - 0.5,
		}));
		const abandoned = scoreRepoLiveness(
			activity({ createdPrs: prs(spec), mergedAt: [] }),
			NOW,
		);
		const merging = scoreRepoLiveness(
			activity({
				createdPrs: prs(
					spec.map(({ created }) => ({ created, merged: created - 0.5 })),
				),
				mergedAt: spec.map(({ created }) => daysAgo(created - 0.5)),
			}),
			NOW,
		);

		expect(abandoned.mergeRate).toBe(0);
		expect(abandoned.score).toBeLessThan(merging.score);
		expect(abandoned.breakdown.maintenance).toBeLessThan(2);
	});

	it("leaves the merge rate unset when nothing has been decided yet", () => {
		const result = scoreRepoLiveness(
			activity({ createdPrs: prs([{ created: 1 }, { created: 2 }]) }),
			NOW,
		);

		expect(result.mergeRate).toBeNull();
	});
});
