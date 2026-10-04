import { defineHandler, html } from "nitro";

type Endpoint = {
	path: string;
	description: string;
	examples?: string[];
};

// Keep in sync with server/api.
const endpoints: Endpoint[] = [
	{
		path: "/api/activity",
		description:
			"Daily scan rollup with per-category progression. Recent window by default.",
		examples: ["/api/activity?full=true"],
	},
	{
		path: "/api/activity/hourly-window",
		description: "Hourly scan results for the rolling window.",
	},
	{
		path: "/api/activity/repo-scores",
		description:
			"Per-repo daily scores. Without params, lists the dates on file.",
		examples: [
			"/api/activity/repo-scores?date=YYYY-MM-DD",
			"/api/activity/repo-scores?from=YYYY-MM-DD&to=YYYY-MM-DD",
			"/api/activity/repo-scores?date=YYYY-MM-DD&repo=owner/name",
		],
	},
	{
		path: "/api/activity/trmnl",
		description:
			"Compact weekly summary and 14-day trend for TRMNL. Cached 15 min.",
	},
	{
		path: "/api/automation-tally",
		description: "Automation account IDs with how often each was seen.",
	},
	{
		path: "/api/libraries",
		description: "Repositories included in the scan.",
	},
];

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const renderEndpoint = ({ path, description, examples = [] }: Endpoint) => `
	<li>
		<div class="row">
			<span class="method">GET</span>
			<a href="${escapeHtml(path)}">${escapeHtml(path)}</a>
		</div>
		<p>${escapeHtml(description)}</p>
		${
			examples.length
				? `<ul class="examples">${examples
						.map((example) => `<li><code>${escapeHtml(example)}</code></li>`)
						.join("")}</ul>`
				: ""
		}
	</li>`;

const page = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>AgentScan API</title>
	<style>
		:root {
			color-scheme: light dark;
			--bg: #fff;
			--fg: #1a1a1a;
			--muted: #666;
			--border: #e5e5e5;
			--accent: #0a66c2;
		}
		@media (prefers-color-scheme: dark) {
			:root {
				--bg: #111;
				--fg: #eee;
				--muted: #999;
				--border: #2a2a2a;
				--accent: #6cb6ff;
			}
		}
		body {
			margin: 0;
			padding: 48px 16px;
			background: var(--bg);
			color: var(--fg);
			font: 15px/1.5 system-ui, sans-serif;
		}
		main { max-width: 720px; margin: 0 auto; }
		h1 { font-size: 20px; margin: 0 0 4px; }
		.lead { color: var(--muted); margin: 0 0 32px; }
		ul { list-style: none; margin: 0; padding: 0; }
		main > ul > li { padding: 16px 0; border-top: 1px solid var(--border); }
		.row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
		.method { font: 600 11px ui-monospace, monospace; color: var(--muted); }
		a { color: var(--accent); font-family: ui-monospace, monospace; text-decoration: none; overflow-wrap: anywhere; }
		a:hover { text-decoration: underline; }
		p { margin: 4px 0 0; color: var(--muted); }
		.examples { margin-top: 8px; }
		code { font-size: 13px; overflow-wrap: anywhere; }
	</style>
</head>
<body>
	<main>
		<h1>AgentScan API</h1>
		<p class="lead">Data endpoints behind <a href="https://github.com/MatteoGabriele/agentscan">AgentScan</a>. All return JSON.</p>
		<ul>${endpoints.map(renderEndpoint).join("")}</ul>
	</main>
</body>
</html>`;

export default defineHandler(() => html(page));
