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
});
