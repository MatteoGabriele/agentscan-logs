import { defineHandler } from "nitro";
import { libraries } from "../../shared/daily-scan";

export default defineHandler(() => {
	return {
		total: libraries.length,
		repos: libraries,
	};
});
