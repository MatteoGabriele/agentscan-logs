import { defineConfig } from "nitro";

export default defineConfig({
	serverDir: "./server",

	// The scan writes its results into data/ and the workflow commits them, so
	// the deploy that follows bundles the files the endpoints below read.
	// hourly-scan-results.txt is kept history that nothing serves — the pattern
	// keeps its ~1.7MB out of the server bundle.
	serverAssets: [
		{
			baseName: "data",
			dir: "./data",
			pattern:
				"{daily-scan-results.json,hourly-window-scan-results.txt,automation-ids.json}",
		},
	],

	// No route caching here on purpose: the endpoints only read bundled files,
	// and the consuming app already caches them at its own edge.
});
