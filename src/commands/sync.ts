import { Command, Option } from 'commander';
import { ethers, utils } from 'ethers';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { relative, resolve } from 'path';
import { promisify } from 'util';
import YAML from 'yaml';
import { transactionApis } from '../constants';
import { generateRootReadme } from '../docs/generatedRootReadme';
import { handleNotifications } from '../notifications';
import { syncProposals } from '../proposal/sync';
import { checkRequirements } from '../requirements';
import { getSafeApiKit } from '../safe-api/kit';
import { syncSafes } from '../safe/sync';
import { State } from '../state';
import { Manifest, SafeCDKit } from '../types';
const exec = promisify(require('child_process').exec);

const rpcOption = new Option('--rpc <char>', 'ethereum rpc endpoint').env('RPC');
rpcOption.mandatory = true;

export default function loadCommand(command: Command): void {
	command
		.command('sync')
		.description('syncs current directory with safes')
		.addOption(rpcOption)
		.addOption(new Option('--dry-run', 'do not write to disk').default(false).env('DRY_RUN'))
		.addOption(new Option('--upload', 'upload to safe').default(false).env('UPLOAD'))
		.action(async options => {
			await checkRequirements();

			console.log();
			console.log('  ================================================  ');
			console.log();
			console.log('  ███████╗ █████╗ ███████╗███████╗ ██████╗██████╗');
			console.log('  ██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██╔══██╗');
			console.log('  ███████╗███████║█████╗  █████╗  ██║     ██║  ██║');
			console.log('  ╚════██║██╔══██║██╔══╝  ██╔══╝  ██║     ██║  ██║');
			console.log('  ███████║██║  ██║██║     ███████╗╚██████╗██████╔╝');
			console.log('  ╚══════╝╚═╝  ╚═╝╚═╝     ╚══════╝ ╚═════╝╚═════╝');
			console.log();
			console.log('  ================================================  ');
			console.log();

			const pks = process.env.PRIVATE_KEYS?.split(',') || [];
			if (process.env.CI === 'true') {
				console.log(`  ci=true`);
			}
			console.log(`  rpc=${options.rpc}`);
			console.log(`  dryRun=${options.dryRun}`);
			console.log(`  upload=${options.upload}`);
			console.log();
			console.log('  ================================================  ');
			console.log();
			const shouldUpload = options.upload;
			const shouldWrite = !options.dryRun;
			const provider = new ethers.providers.JsonRpcProvider(options.rpc);
			const signers: { [key: string]: ethers.Signer } = {};
			let loaded = false;
			for (const pk of pks) {
				loaded = true;
				const signer = new ethers.Wallet(pk, provider);
				signers[utils.getAddress(signer.address)] = signer;
				console.log(`  loaded signer for ${await signer.address}`);
			}
			if (loaded) {
				console.log();
				console.log('  ================================================  ');
				console.log();
			}
			const chainId = (await provider.getNetwork()).chainId;
			const state = new State();
			await state.load();
			const safeApiUrl = transactionApis[state.config.network] as string;
			if (!safeApiUrl) {
				throw new Error(`Unsupported network ${state.config.network}`);
			}
			const sak = await getSafeApiKit(provider, safeApiUrl);
			const scdk: SafeCDKit = {
				sak,
				provider,
				signers,
				rpcUrl: options.rpc,
				safeUrl: safeApiUrl,
				shouldUpload,
				shouldWrite,
				network: state.config.network,
				network_id: chainId,
				state
			};

			console.log('stage 1: syncing safes, transactions, owners and delegates');
			await syncSafes(scdk);
			console.log('stage 1: done.');

			if (scdk.shouldWrite && scdk.shouldUpload) {
				console.log('stage 2: syncing & uploading proposals');
			} else {
				console.log('stage 2: syncing proposals');
			}
			const hasProposed = await syncProposals(scdk);
			console.log('stage 2: done.');

			if (hasProposed) {
				console.log('stage 3: sleeping 10 seconds then syncing safes, transactions, owners and delegates');
				await new Promise(resolve => setTimeout(resolve, 10000));
				await syncSafes(scdk);
				console.log('stage 3: done.');
			}

			if (scdk.shouldWrite && scdk.shouldUpload) {
				await handleNotifications(scdk);
			}

			console.log();
			console.log('  ================================================  ');
			console.log();

			const updatedReadme = await generateRootReadme(scdk);
			if (updatedReadme !== null) {
				writeFileSync('./README.md', updatedReadme);
			}

			await scdk.state.diff();
			const saveResult = await scdk.state.save();

			let error = 0;

			if (saveResult !== null) {
				if (updatedReadme !== null) {
					saveResult.commit.edits += 1;
					saveResult.commit.message += `- edit   README.md\n`;
				}
				if (saveResult.commit.creations + saveResult.commit.edits + saveResult.commit.deletions > 0) {
					const COMMIT_MSG = `create=${saveResult.commit.creations} edit=${saveResult.commit.edits} delete=${saveResult.commit.deletions}\n\n${saveResult.commit.message}\n\n[skip ci]\n`;
					writeFileSync('COMMIT_MSG', COMMIT_MSG, { encoding: 'utf8' });
					await exec(`echo "hasChanges=true" >> $GITHUB_OUTPUT`);
					console.log('writting "hasChanged=true" ci output variable');
				} else if (existsSync('COMMIT_MSG')) {
					unlinkSync('COMMIT_MSG');
				}
				if (process.env.CI === 'true') {
					console.log("looking for proposal manifests in './script'");
					const proposalManifests = gatherProposalManifests();
					if (proposalManifests.length > 0) {
						let content = '## Proposal Simulation Manifests\n\n';
						for (const proposalManifest of proposalManifests) {
							console.log(`  formatting ${proposalManifest}`);
							const manifest = YAML.parse(
								readFileSync(proposalManifest, { encoding: 'utf8' })
							) as Manifest;
							const proposalManifestContent = formatManifestToMarkdown(proposalManifest, manifest);
							content += `${proposalManifestContent}`;
							if (manifest.error) {
								error += 1;
							}
						}
						writeFileSync('PR_COMMENT', content, { encoding: 'utf8' });
						await exec(`echo "hasPrComment=true" >> $GITHUB_OUTPUT`);
						console.log('writting "hasPrComment=true" ci output variable');
					}
				}
			}

			if (error > 0) {
				command.error("there's an error in one of the proposal manifests", { exitCode: error });
			}
		});
}

function formatManifestToMarkdown(path: string, manifest: Manifest): string {
	const { title, description, ...proposalWithoutMetadata } = manifest.raw_proposal;
	if (manifest.error === undefined) {
		return `
---

# ${title} ✅

### \`${path}\`

${description || ''}

### Safe Tx Hash

\`\`\`solidity
${manifest.raw_proposal?.safeTxHash}
\`\`\`

<details>
<summary><bold>Expand for full proposal details</bold></summary>

### Proposal

\`\`\`yaml
${YAML.stringify(proposalWithoutMetadata, { lineWidth: 0 })}
\`\`\`

### Safe Transaction

\`\`\`yaml
${YAML.stringify(manifest.safe_transaction, { lineWidth: 0 })}
\`\`\`

### Safe

\`\`\`yaml
${YAML.stringify(manifest.safe, { lineWidth: 0 })}
\`\`\`

${
	proposalWithoutMetadata.childOf
		? ''
		: `
### Proposal Script

\`\`\`solidity
${manifest.raw_script}
\`\`\`

### Proposal Script Simulation Output

\`\`\`
${manifest.simulation_output}
\`\`\`

### Proposal Script Command

\`\`\`shell
${manifest.raw_command}
\`\`\`

### Proposal Script Simulation Transactions

\`\`\`yaml
${YAML.stringify(manifest.simulation_transactions, { lineWidth: 0 })}
\`\`\`
`
}

### Safe Estimation

\`\`\`yaml
${YAML.stringify(manifest.safe_estimation, { lineWidth: 0 })}
\`\`\`

</details>
`;
	} else {
		return `
	
# ${title} ✅

### \`${path}\`

${description || ''}

### Error

\`\`\`
${manifest.error}
\`\`\`

### Proposal

\`\`\`yaml
${YAML.stringify(proposalWithoutMetadata, { lineWidth: 0 })}
\`\`\`

### Safe

\`\`\`yaml
${YAML.stringify(manifest.safe, { lineWidth: 0 })}
\`\`\`

${
	proposalWithoutMetadata.childOf
		? ''
		: `
### Proposal Script

\`\`\`solidity
${manifest.raw_script}
\`\`\`

### Proposal Script Simulation Output

\`\`\`
${manifest.simulation_output}
\`\`\`

### Proposal Script Command

\`\`\`shell
${manifest.raw_command}
\`\`\`

### Proposal Script Simulation Transactions

\`\`\`yaml
${YAML.stringify(manifest.simulation_transactions, { lineWidth: 0 })}
\`\`\`
`
}

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
