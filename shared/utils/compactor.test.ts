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

	it("round-trips the description verdict after the line counts", () => {
		const items: EcosystemHealthItem[] = [
			{
				...ITEMS[0],
				additions: 12,
				deletions: 3,
				text_verdict: "ai",
				text_confidence: 0.897,
				text_probability: 0.897,
				text_template_found: true,
			},
			{
				...ITEMS[1],
				additions: 1,
				deletions: 0,
				text_verdict: "human",
				text_confidence: 0.8,
				text_probability: 0.2,
				text_template_found: false,
			},
		];
		const packed = pack(items);

		expect(packed.split("\n")[1]?.split(",").slice(9)).toEqual([
			"12",
			"3",
			"a",
			"0.897",
			"0.897",
			"1",
		]);
		expect(unpack(packed)).toEqual(items);
	});

	it("keeps the verdict of an unsized PR in its own columns", () => {
		const items: EcosystemHealthItem[] = [
			{
				...ITEMS[0],
				text_verdict: "human",
				text_confidence: 0.9,
				text_probability: 0.1,
			},
		];

		expect(unpack(pack(items))).toEqual(items);
	});

	it("reads verdicts written before the template column existed", () => {
		const items: EcosystemHealthItem[] = [
			{
				...ITEMS[0],
				text_verdict: "ai",
				text_confidence: 0.7,
				text_probability: 0.7,
			},
		];
		const packed = pack(items);

		expect(packed.split("\n")[1]?.split(",")).toHaveLength(14);
		expect(unpack(packed)[0]).not.toHaveProperty("text_template_found");
	});

	it("reads rows written before the description columns existed", () => {
		const items: EcosystemHealthItem[] = [
			{ ...ITEMS[0], additions: 5, deletions: 2 },
		];

		expect(unpack(pack(items))).toEqual(items);
		expect(pack(items).split("\n")[1]?.split(",")).toHaveLength(11);
	});
});
