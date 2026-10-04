import type { IdentityClassification } from "@unveil/identity";
import type { calcLinearProgression } from "../utils/calc-linear-progression";

export type PrStatus = "open" | "closed" | "merged";

export type TextVerdict = "ai" | "human";

// Categories plotted on the health graph. "insufficient-data" scans are stored
// with a negative score and excluded from every aggregate.
export type EcosystemHealthCategory = Exclude<
	IdentityClassification,
	"insufficient-data"
>;

export type EcosystemHealthItem = {
	created_at: string;
	score: number;
	/** Null when the PR number is unknow due to older data corruption or other changes. */
	pr: number | null;
	pr_status: PrStatus;
	user_created_at: string;
	user_public_repos_count: number;
	events_count: number;
	repo_name: string;
	is_bounty: boolean;
	additions?: number;
	deletions?: number;
	/**
	 * @unveil/interlinked's read of the PR description. Absent when the PR had
	 * no description to read, or was scanned before the analysis was added.
	 */
	text_verdict?: TextVerdict;
	/** Confidence in `text_verdict`, 0.5 to 1. */
	text_confidence?: number;
	/** Probability the description is agent-written, 0 to 1. */
	text_probability?: number;
	/**
	 * Whether the repo's PR template was found and paired with the description
	 * when it was read. Absent wherever `text_verdict` is.
	 */
	text_template_found?: boolean;
};

export type EcosystemHealthCategoryCounts = {
	automation: number;
	mixed: number;
	organic: number;
};

export type EcosystemHealthCategoryProgression = Record<
	EcosystemHealthCategory,
	ReturnType<typeof calcLinearProgression>
>;
