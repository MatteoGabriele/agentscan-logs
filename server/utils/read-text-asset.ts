import { HTTPError } from "nitro";
import { useStorage } from "nitro/storage";

/**
 * Reads one of the scan result files the hourly workflow commits into `data/`.
 * They are bundled as server assets, so a miss means the deploy went out
 * without them rather than a request the caller can fix.
 */
export async function readTextAsset(fileName: string): Promise<string> {
	const raw = await useStorage("assets:data").getItemRaw(fileName);

	if (!raw) {
		throw new HTTPError({
			status: 500,
			message: `${fileName} is missing from the deployed bundle`,
		});
	}

	if (typeof raw === "string") {
		return raw;
	}

	return new TextDecoder().decode(raw as Uint8Array);
}
