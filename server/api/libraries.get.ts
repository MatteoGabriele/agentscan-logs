import { defineHandler } from "nitro";
import { libraries, libraryCategories } from "../../shared/daily-scan";

export default defineHandler(() => {
	return {
		total: libraries.length,
		repos: libraries,
		categories: libraryCategories,
	};
});
