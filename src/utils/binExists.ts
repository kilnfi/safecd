import { execSync } from 'child_process';
const shell = (cmd: string) => execSync(cmd, { encoding: 'utf8' });

export async function binExists(binaryName: string): Promise<boolean> {
	try { shell(`which ${binaryName}`); return true }
	catch (error) { return false }
}

export async function whereBin(binaryName: string): Promise<string | null> {
	try { return shell(`which ${binaryName}`).replace('\n', '') }
	catch (error) { return '' }
}