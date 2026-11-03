import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { libraries } from "../../shared/daily-scan";
import type { DailyRepoScores } from "../../shared/utils/daily-repo-scores";

function readData(file: string): string {
	return readFileSync(join(__dirname, "../../data", file), "utf-8");
}

function notLowercase(names: string[]): string[] {
	return names.filter((name) => name !== name.toLowerCase());
}

// `RepoName` already makes `tsc` reject a mixed-case entry in `libraries`;
// these cover what the compiler can't see — the names already written to disk.
describe("repo name casing", () => {
	it("lists each repo once", () => {
		expect(
			libraries.filter((name, i) => libraries.indexOf(name) !== i),
		).toEqual([]);
	});

	it("stores daily repo scores under lowercase names", () => {
		const scores = JSON.parse(
			readData("daily-repo-scores.json"),
		) as DailyRepoScores;

		expect(
			Object.values(scores).flatMap((repos) =>
				notLowercase(Object.keys(repos)),
			),
		).toEqual([]);
	});

	it("stores hourly results under lowercase names", () => {
		const header = readData("hourly-window-scan-results.txt").split("\n", 1)[0];

		expect(header.startsWith("REPOS:")).toBe(true);
		expect(notLowercase(header.slice("REPOS:".length).split(","))).toEqual([]);
	});
});
