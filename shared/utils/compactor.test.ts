import { describe, expect, it } from "vitest";
import type { EcosystemHealthItem } from "../types/ecosystem-health";
import { pack, unpack } from "./compactor";

const ITEMS: EcosystemHealthItem[] = [
	{
		created_at: "2026-05-26T19:27:30.000Z",
		score: 100,
		pr: 1,
		pr_status: "open",
		user_created_at: "2017-05-15T12:06:30.000Z",
		user_public_repos_count: 869,
		events_count: 200,
		repo_name: "nuxt/nuxt",
		is_bounty: false,
	},
	{
		created_at: "2026-05-26T19:27:30.000Z",
		score: 40,
		pr: 2,
		pr_status: "closed",
		user_created_at: "2026-05-23T17:48:23.000Z",
		user_public_repos_count: 2,
		events_count: 20,
		repo_name: "nuxt/nuxt",
		is_bounty: false,
	},
	{
		created_at: "2026-05-26T19:27:30.000Z",
		score: 40,
		pr: 3,
		pr_status: "merged",
		user_created_at: "2026-05-23T17:48:23.000Z",
		user_public_repos_count: 2,
		events_count: 20,
		repo_name: "nuxt/nuxt",
		is_bounty: true,
	},
];

describe("pack / unpack", () => {
	it("round-trips open, closed and merged PR statuses", () => {
		const packed = pack(ITEMS);
		const unpacked = unpack(packed);

		expect(unpacked).toEqual(ITEMS);
	});

	it("encodes merged PRs distinctly from closed PRs", () => {
		const packed = pack(ITEMS);
		const lines = packed.split("\n");

		expect(lines[1]?.split(",")[3]).toBe("o");
		expect(lines[2]?.split(",")[3]).toBe("c");
		expect(lines[3]?.split(",")[3]).toBe("m");
	});

	it("round-trips a missing PR as null", () => {
		const items: EcosystemHealthItem[] = [{ ...ITEMS[0], pr: null }];

		expect(unpack(pack(items))).toEqual(items);
	});

	it("ignores the description columns of rows written before 2026-11-01", () => {
		const packed = pack([{ ...ITEMS[0], additions: 12, deletions: 3 }]);
		const [header, row] = packed.split("\n");
		const items = unpack(`${header}\n${row},a,0.897,0.897,1`);

		expect(items).toEqual([{ ...ITEMS[0], additions: 12, deletions: 3 }]);
		expect(pack(items)).toBe(packed);
	});

	it("writes the line counts as the last columns", () => {
		const items: EcosystemHealthItem[] = [
			{ ...ITEMS[0], additions: 5, deletions: 2 },
		];

		expect(unpack(pack(items))).toEqual(items);
		expect(pack(items).split("\n")[1]?.split(",")).toHaveLength(11);
	});

	it("round-trips a timezone after the line counts", () => {
		const items: EcosystemHealthItem[] = [
			{ ...ITEMS[0], additions: 5, deletions: 2, timezone: -300 },
			{ ...ITEMS[1], additions: 0, deletions: 0, timezone: 0 },
			{ ...ITEMS[2], additions: 1, deletions: 1, timezone: 330 },
		];

		expect(unpack(pack(items))).toEqual(items);
		expect(pack(items).split("\n")[1]?.split(",")).toHaveLength(12);
		expect(pack(items).split("\n")[3]?.endsWith(",330")).toBe(true);
	});

	it("keeps a timezone on a row that was never sized", () => {
		const items: EcosystemHealthItem[] = [{ ...ITEMS[0], timezone: 330 }];

		expect(pack(items).split("\n")[1]?.endsWith(",,,330")).toBe(true);
		expect(unpack(pack(items))).toEqual(items);
	});
});
