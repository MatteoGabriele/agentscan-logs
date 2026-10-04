/// <reference types="node" />

import type {
	EcosystemHealthItem,
	PrStatus,
	TextVerdict,
} from "../types/ecosystem-health";

// Compact CSV format for scan results — ~72% smaller than pretty-printed JSON.
//
// Line 0:  REPOS:<comma-separated repo names>   (index lookup)
// Lines 1+: <created_ts>,<score>,<pr>,<status>,<user_ts>,<repos>,<events>,<repo_idx>,<is_bounty>[,<additions>,<deletions>[,<verdict>,<confidence>,<probability>[,<template>]]]
//
//   created_ts / user_ts : unix seconds (drops sub-second precision)
//   pr                   : PR number (empty when unknown, unpacks as null)
//   status               : "o" = open | "c" = closed | "m" = merged
//   repo_idx             : index into the REPOS header
//   is_bounty            : 1 = bounty hunter | 0 = not
//   additions/deletions  : lines changed by the PR (empty when unsized but the
//                          text columns follow)
//   verdict              : "a" = ai | "h" = human, @unveil/interlinked's read of
//                          the PR description
//   confidence           : confidence in the verdict, 0.5 to 1
//   probability          : probability the description is agent-written, 0 to 1
//   template             : 1 = read with the repo's PR template | 0 = without

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

const VERDICT_ENCODE: Record<TextVerdict, string> = { ai: "a", human: "h" };
const VERDICT_DECODE: Record<string, TextVerdict> = { a: "ai", h: "human" };

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

	const isSized = row.additions != null && row.deletions != null;
	const hasText =
		row.text_verdict != null &&
		row.text_confidence != null &&
		row.text_probability != null;

	if (isSized || hasText) {
		fields.push(row.additions ?? "", row.deletions ?? "");
	}

	if (hasText) {
		fields.push(
			VERDICT_ENCODE[row.text_verdict as TextVerdict],
			row.text_confidence,
			row.text_probability,
		);

		if (row.text_template_found != null) {
			fields.push(row.text_template_found ? 1 : 0);
		}
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
			verdict = "",
			confidence,
			probability,
			templateFound = "",
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
			...(VERDICT_DECODE[verdict] &&
				confidence &&
				probability && {
					text_verdict: VERDICT_DECODE[verdict],
					text_confidence: Number(confidence),
					text_probability: Number(probability),
					...(templateFound !== "" && {
						text_template_found: templateFound === "1",
					}),
				}),
		});
	}

	return results;
}
