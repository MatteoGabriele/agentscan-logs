/// <reference types="node" />

import type { EcosystemHealthItem, PrStatus } from "../types/ecosystem-health";

// Compact CSV format for scan results — ~72% smaller than pretty-printed JSON.
//
// Line 0:  REPOS:<comma-separated repo names>   (index lookup)
// Lines 1+: <created_ts>,<score>,<pr>,<status>,<user_ts>,<repos>,<events>,<repo_idx>,<is_bounty>[,<additions>,<deletions>]
//
//   created_ts / user_ts : unix seconds (drops sub-second precision)
//   pr                   : PR number (empty when unknown, unpacks as null)
//   status               : "o" = open | "c" = closed | "m" = merged
//   repo_idx             : index into the REPOS header
//   is_bounty            : 1 = bounty hunter | 0 = not
//   additions/deletions  : lines changed by the PR

const STATUS_ENCODE: Record<string, string> = {
	open: "o",
	closed: "c",
	merged: "m",
};
const STATUS_DECODE: Record<string, string> = {
	o: "open",
	c: "closed",
	m: "merged",
};

function toUnixSecs(isoDate: string): number {
	return Math.floor(new Date(isoDate).getTime() / 1000);
}

function fromUnixSecs(secs: number): string {
	return new Date(secs * 1000).toISOString();
}

export function pack(results: EcosystemHealthItem[]): string {
	const repoList: string[] = [];
	const repoIndex = new Map<string, number>();

	for (const r of results) {
		if (!repoIndex.has(r.repo_name)) {
			repoIndex.set(r.repo_name, repoList.length);
			repoList.push(r.repo_name);
		}
	}

	const lines: string[] = [`REPOS:${repoList.join(",")}`];

	for (const r of results) {
		lines.push(packRow(r, repoIndex.get(r.repo_name)));
	}

	return lines.join("\n");
}

function packRow(
	row: EcosystemHealthItem,
	repoIdx: number | undefined,
): string {
	const fields: (string | number | undefined)[] = [
		toUnixSecs(row.created_at),
		row.score,
		row.pr ?? "",
		STATUS_ENCODE[row.pr_status] ?? row.pr_status,
		toUnixSecs(row.user_created_at),
		row.user_public_repos_count,
		row.events_count,
		repoIdx,
		row.is_bounty ? 1 : 0,
	];

	if (row.additions != null && row.deletions != null) {
		fields.push(row.additions, row.deletions);
	}

	return fields.join(",");
}

export function unpack(content: string): EcosystemHealthItem[] {
	const lines = content.split("\n");
	if (!lines[0]?.startsWith("REPOS:")) {
		return [];
	}

	const repos = lines[0].slice(6).split(",").filter(Boolean);
	const results: EcosystemHealthItem[] = [];

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line?.trim()) {
			continue;
		}

		const fields = line.split(",");
		if (fields.length < 8) {
			continue;
		}

		const [
			createdTs,
			score,
			pr = "",
			status = "",
			userCreatedTs,
			publicRepos,
			events,
			repoIdx,
			isBounty,
			additions,
			deletions,
		] = fields;

		const numCreatedTs = Number(createdTs);
		const numUserCreatedTs = Number(userCreatedTs);
		const numPublicRepos = Number(publicRepos);
		const numEvents = Number(events);
		const numRepoIdx = Number(repoIdx);

		if (
			!Number.isFinite(numCreatedTs) ||
			!Number.isFinite(numUserCreatedTs) ||
			!Number.isFinite(numPublicRepos) ||
			!Number.isFinite(numEvents) ||
			!Number.isFinite(numRepoIdx)
		) {
			continue;
		}

		results.push({
			created_at: fromUnixSecs(numCreatedTs),
			score: Number(score),
			pr: pr ? Number(pr) : null,
			pr_status: (STATUS_DECODE[status] ?? status) as PrStatus,
			user_created_at: fromUnixSecs(numUserCreatedTs),
			user_public_repos_count: numPublicRepos,
			events_count: numEvents,
			repo_name: repos[numRepoIdx] ?? "",
			is_bounty: isBounty === "1",
			...(additions &&
				deletions && {
					additions: Number(additions),
					deletions: Number(deletions),
				}),
		});
	}

	return results;
}
