import { binExists } from "./utils/binExists";

export async function checkRequirements(): Promise<void> {
	await checkFoundry();
}

async function checkFoundry(): Promise<void> {
	if (!await binExists("forge")) {
		throw new Error("Missing forge binary")
	}
}