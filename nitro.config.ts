import { defineConfig } from "nitro";

export default defineConfig({
	serverDir: "./server",

	// The scan writes its results into data/ and the workflow commits them, so
	// the deploy that follows bundles the files the endpoints below read.
	serverAssets: [
		{
			baseName: "data",
			dir: "./data",
			pattern:
				"{daily-scan-results.json,daily-repo-scores.json,hourly-window-scan-results.txt,automation-ids.json}",
		},
	],

	// /api/health was renamed to /api/activity
	routeRules: {
		"/api/health": {
			redirect: {
				to: "/api/activity",
				status: 308,
			},
		},
		"/api/health/**": {
			redirect: {
				to: "/api/activity/**",
				status: 308,
			},
		},
	},
});
