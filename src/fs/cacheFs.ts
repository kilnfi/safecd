var gitDiff = require('git-diff');
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import { promisify } from 'util';
import YAML from 'yaml';
import { Manifest } from '../types';
const exec = promisify(require('child_process').exec);
export class CacheFS {
	private edits: { [key: string]: string | null } = {};

	read(file: string): string {
		file = resolve(file);
		return this.edits[file] || readFileSync(file, 'utf8');
	}

	write(file: string, content: string): void {
		file = resolve(file);
		if (existsSync(file) && this.read(file) === content) {
			delete this.edits[file];
			return;
		}
		this.edits[file] = content;
	}

	remove(file: string): void {
		file = resolve(file);
		this.edits[file] = null;
	}

	printDiff(): void {
		for (let [file, content] of Object.entries(this.edits)) {
			const diff = gitDiff(existsSync(file) ? readFileSync(file, { encoding: 'utf8' }) : '', content || '', {
				color: true,
				forceFake: true
			});
			if (diff !== undefined) {
				console.log(`${file}:`);
				console.log();
				console.log(diff);
				console.log();
			}
		}
	}

	async commit(write: boolean): Promise<void> {
		if (!write) {
			return;
		}
		let COMMIT_MSG = '';
		let editionCount = 0;
		let deletionCount = 0;
		let creationCount = 0;
		for (const [file, content] of Object.entries(this.edits)) {
			if (content === null) {
				if (existsSync(file)) {
					COMMIT_MSG += `- delete ${relative('.', file)}\n`;
					++deletionCount;
				}
				console.log(`deleting ${file}.`);
				unlinkSync(file);
			} else {
				if (!existsSync(file)) {
					COMMIT_MSG += `- create ${relative('.', file)}\n`;
					++creationCount;
				} else if (readFileSync(file, { encoding: 'utf8' }) !== content) {
					COMMIT_MSG += `- edit   ${relative('.', file)}\n`;
					++editionCount;
				}
				console.log(`writting ${file}.`);
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, content, { encoding: 'utf8' });
			}
		}
		if (COMMIT_MSG !== '') {
			COMMIT_MSG = `safecd: create=${creationCount} edit=${editionCount} delete=${deletionCount}\n\n${COMMIT_MSG}`;
			writeFileSync('COMMIT_MSG', COMMIT_MSG, { encoding: 'utf8' });
			if (process.env.CI === 'true') {
				await exec(`echo "hasChanges=true" >> $GITHUB_OUTPUT`);
				console.log('writting "hasChanged=true" ci output variable');
			}
		} else if (existsSync('COMMIT_MSG')) {
			unlinkSync('COMMIT_MSG');
		}
		if (process.env.CI === 'true') {
			console.log("looking for proposal manifests in './script'");
			const proposalManifests = gatherProposalManifests();
			if (proposalManifests.length > 0) {
				let content = '# Proposal Simulation Manifests\n\n';
				for (const proposalManifest of proposalManifests) {
					console.log(`  formatting ${proposalManifest}`);
					const proposalManifestContent = formatManifestToMarkdown(
						proposalManifest,
						YAML.parse(readFileSync(proposalManifest, { encoding: 'utf8' }))
					);
					content += `${proposalManifestContent}`;
				}
				await exec(`echo "hasPrComment=true" >> $GITHUB_OUTPUT`);
				writeFileSync('PR_COMMENT', content, { encoding: 'utf8' });
				console.log('writting "hasPrComment=true" ci output variable');
			}
		}
	}
}

function formatManifestToMarkdown(path: string, manifest: Manifest): string {
	const { title, description, ...proposalWithoutMetadata } = manifest.raw_proposal;
	if (manifest.error === undefined) {
		return `
	
## \`${path}\` ✅

### ${title}

${description || ''}

### Proposal

\`\`\`yaml
${YAML.stringify(proposalWithoutMetadata)}
\`\`\`

### Safe Transaction

\`\`\`yaml
${YAML.stringify(manifest.safe_transaction)}
\`\`\`

### Safe

\`\`\`yaml
${YAML.stringify(manifest.safe)}
\`\`\`

### Proposal Script

\`\`\`solidity
${manifest.raw_script}
\`\`\`

### Proposal Script Simulation Output

\`\`\`
${manifest.simulation_output}
\`\`\`

### Proposal Script Simulation Transactions

\`\`\`yaml
${YAML.stringify(manifest.simulation_transactions)}
\`\`\`

### Safe Estimation

\`\`\`yaml
${YAML.stringify(manifest.safe_estimation)}
\`\`\`

`;
	} else {
		return `
	
## \`${path}\` ❌

\`\`\`
${manifest.error}
\`\`\`

### ${title}

${description || ''}

### Proposal

\`\`\`yaml
${YAML.stringify(proposalWithoutMetadata)}
\`\`\`

### Safe

\`\`\`yaml
${YAML.stringify(manifest.safe)}
\`\`\`

### Proposal Script

\`\`\`solidity
${manifest.raw_script}
\`\`\`

### Proposal Script Simulation Output

\`\`\`
${manifest.simulation_output}
\`\`\`

### Proposal Script Simulation Error Output

\`\`\`
${manifest.simulation_error_output}
\`\`\`

`;
	}
}

function gatherProposalManifests(): string[] {
	return gatherProposalManifestsInDir(resolve('./script'));
}

function gatherProposalManifestsInDir(path: string): string[] {
	const elements = readdirSync(path);
	let manifests: string[] = [];
	for (const element of elements) {
		if (element.endsWith('.proposal.manifest.yaml')) {
			manifests.push(relative(resolve('.'), resolve(path, element)));
		}
		if (statSync(resolve(path, element)).isDirectory()) {
			manifests = [...manifests, ...gatherProposalManifestsInDir(resolve(path, element))];
		}
	}
	return manifests;
}
