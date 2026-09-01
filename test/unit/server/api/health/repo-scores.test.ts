import { HTTPError } from "nitro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyRepoScores } from "../../../../../shared/utils/daily-repo-scores";

const { readTextAsset } = vi.hoisted(() => ({ readTextAsset: vi.fn() }));

vi.mock("../../../../../server/utils/read-text-asset", () => ({
	readTextAsset,
}));

const repoScores = (
	await import("../../../../../server/api/health/repo-scores.get")
).default;

const SCORES: DailyRepoScores = {
	"2026-08-27": { "nuxt/nuxt": [1, 40] },
	"2026-08-28": { "nuxt/nuxt": [2, 150], "vuejs/core": [1, 90] },
	"2026-08-29": { "vuejs/core": [3, 240] },
};

const DATES = ["2026-08-27", "2026-08-28", "2026-08-29"];

function request(query = "") {
	return repoScores({
		url: new URL(`http://localhost/api/health/repo-scores${query}`),
	} as never);
}

beforeEach(() => {
	readTextAsset.mockReset();
	readTextAsset.mockResolvedValue(JSON.stringify(SCORES));
});

describe("GET /api/health/repo-scores", () => {
	it("answers with the dates on file and nothing else", async () => {
		await expect(request()).resolves.toEqual({ dates: DATES });
	});

	it("answers a single date with that day's repos, busiest first", async () => {
		await expect(request("?date=2026-08-28")).resolves.toEqual({
			date: "2026-08-28",
			dates: DATES,
			repos: [
				{ name: "nuxt/nuxt", count: 2, scoreSum: 150 },
				{ name: "vuejs/core", count: 1, scoreSum: 90 },
			],
		});
	});

	it("narrows a single date to one repo", async () => {
		await expect(request("?date=2026-08-28&repo=vuejs/core")).resolves.toEqual({
			date: "2026-08-28",
			dates: DATES,
			repos: [{ name: "vuejs/core", count: 1, scoreSum: 90 }],
		});
	});

	it("answers a range with the days it covers and the summed repos", async () => {
		await expect(request("?from=2026-08-27&to=2026-08-28")).resolves.toEqual({
			from: "2026-08-27",
			to: "2026-08-28",
			rangeDates: ["2026-08-27", "2026-08-28"],
			dates: DATES,
			repos: [
				{ name: "nuxt/nuxt", count: 3, scoreSum: 190 },
				{ name: "vuejs/core", count: 1, scoreSum: 90 },
			],
		});
	});

	it("runs an open-ended range to the edges of the file", async () => {
		await expect(request("?from=2026-08-29")).resolves.toMatchObject({
			from: "2026-08-29",
			to: "2026-08-29",
			rangeDates: ["2026-08-29"],
		});

		await expect(request("?to=2026-08-27")).resolves.toMatchObject({
			from: "2026-08-27",
			to: "2026-08-27",
			rangeDates: ["2026-08-27"],
		});
	});

	it("answers a range that names unmeasured days with the days it holds", async () => {
		await expect(
			request("?from=2026-01-01&to=2026-08-27"),
		).resolves.toMatchObject({
			rangeDates: ["2026-08-27"],
			repos: [{ name: "nuxt/nuxt", count: 1, scoreSum: 40 }],
		});
	});

	it.each(["?date=29-08-2026", "?from=nope", "?to=2026-13-40"])(
		"rejects %s as a bad request",
		async (query) => {
			const error = await request(query).catch((thrown) => thrown);

			expect(error).toBeInstanceOf(HTTPError);
			expect(error.status).toBe(400);
		},
	);

	it("rejects a range that ends before it starts", async () => {
		await expect(
			request("?from=2026-08-29&to=2026-08-27"),
		).rejects.toMatchObject({ status: 400 });
	});

	it("reports a missing or unreadable asset as ours", async () => {
		// The handler logs the cause before answering 500. Stubbed rather than
		// left alone so the deliberate failure does not print a stack trace
		// into a passing run, and asserted so the log stays part of the
		// contract: a 500 the server never wrote down is not debuggable.
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const cause = new Error("gone");

		readTextAsset.mockRejectedValue(cause);

		await expect(request("?date=2026-08-28")).rejects.toMatchObject({
			status: 500,
		});
		expect(logged).toHaveBeenCalledWith(
			"Daily repo scores fetch error:",
			cause,
		);

		logged.mockRestore();
	});
});
