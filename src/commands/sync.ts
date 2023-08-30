import { Command, Option } from 'commander';
import { ethers, utils } from 'ethers';
import { writeFileSync } from 'fs';
import { promisify } from 'util';
import { transactionApis } from '../constants';
import { generateRootReadme } from '../docs/generatedRootReadme';
import { CacheFS } from '../fs/cacheFs';
import { syncProposals } from '../proposal/sync';
import { checkRequirements } from '../requirements';
import { getSafeApiKit } from '../safe-api/kit';
import { syncSafes } from '../safe/sync';
import { GlobalConfig, GlobalConfigSchema, load, SafeCDKit } from '../types';
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
			const fs = new CacheFS();
			const chainId = (await provider.getNetwork()).chainId;
			const config: GlobalConfig = load<GlobalConfig>(fs, GlobalConfigSchema, './safecd.yaml');
			const safeApiUrl = transactionApis[config.network] as string;
			if (!safeApiUrl) {
				throw new Error(`Unsupported network ${config.network}`);
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
				fs,
				network: config.network,
				network_id: chainId,
				config
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

			console.log();
			console.log('  ================================================  ');
			console.log();

			scdk.fs.printDiff();
			const result = await scdk.fs.commit(scdk.shouldWrite);

			scdk.fs = new CacheFS();
			const updatedReadme = await generateRootReadme(scdk);
			if (updatedReadme !== null) {
				writeFileSync('./README.md', updatedReadme);
			}
			if (result !== null) {
				if (result.hasChanges) {
					writeFileSync('COMMIT_MSG', result.commitMsg, { encoding: 'utf8' });
					await exec(`echo "hasChanges=true" >> $GITHUB_OUTPUT`);
					console.log('writting "hasChanged=true" ci output variable');
				}
				if (result.hasPrComment) {
					writeFileSync('PR_COMMENT', result.prComment, { encoding: 'utf8' });
					await exec(`echo "hasPrComment=true" >> $GITHUB_OUTPUT`);
					console.log('writting "hasPrComment=true" ci output variable');
				}
			}
		});
}
