import { utils } from 'ethers';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, resolve } from 'path';
import { promisify } from 'util';
import { getSafeKit } from '../safe-api/kit';
import {
	ForgeTransaction,
	load,
	Manifest,
	PopulatedSafe,
	PopulatedSafeSchema,
	Proposal,
	ProposalSchema,
	SafeCDKit
} from '../types';
import { whereBin } from '../utils/binExists';
import { noColor } from '../utils/noColor';
import { yamlToString } from '../utils/yamlToString';
const exec = promisify(require('child_process').exec);

export async function syncProposals(scdk: SafeCDKit): Promise<boolean> {
	return syncProposalsDir(scdk, resolve('./script'));
}

async function syncProposalsDir(scdk: SafeCDKit, path: string): Promise<boolean> {
	const elements = readdirSync(path);
	let hasProposedOne = false;
	for (const element of elements) {
		const elementPath = resolve(path, element);
		const stat = statSync(elementPath);
		if (stat.isDirectory()) {
			if (await syncProposalsDir(scdk, elementPath)) {
				hasProposedOne = true;
			}
		} else if (stat.isFile() && element.endsWith('.proposal.yaml')) {
			const prefix = element.slice(0, element.indexOf('.proposal.yaml'));
			const [proposal, manifest, hasProposed] = await syncProposal(scdk, path, element);
			if (manifest !== null) {
				const manifestYaml = yamlToString(manifest);
				console.log(`writting manifest ${resolve(path, `${prefix}.proposal.manifest.yaml`)}`);
				writeFileSync(resolve(path, `${prefix}.proposal.manifest.yaml`), manifestYaml);
				const proposalYaml = yamlToString(proposal);
				scdk.fs.write(resolve(path, element), proposalYaml);
			}
			console.log(`synced proposal ${resolve(path, element)}`);
			if (hasProposed) {
				hasProposedOne = true;
			}
		}
	}
	return hasProposedOne;
}

async function getSafeByName(scdk: SafeCDKit, name: string): Promise<PopulatedSafe | null> {
	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		if (safe.name === name) {
			return safe;
		}
	}
	return null;
}

function delegateExists(safe: PopulatedSafe, address: string): boolean {
	for (const delegate of safe.delegates) {
		if (utils.getAddress(delegate.delegate) === utils.getAddress(address)) {
			return true;
		}
	}
	return false;
}

async function syncProposal(
	scdk: SafeCDKit,
	context: string,
	proposal: string
): Promise<[Proposal, Manifest | null, boolean]> {
	const proposalConfig: Proposal = load<Proposal>(scdk.fs, ProposalSchema, resolve(context, proposal));
	if (proposalConfig.safeTxHash) {
		return [proposalConfig, null, false];
	}
	const safeName = proposalConfig.safe;
	const safe = await getSafeByName(scdk, safeName);
	if (safe === null) {
		throw new Error(`Safe ${safeName} not found`);
	}
	const sender = safe.address;
	const command = `${await whereBin('forge')} script ${resolve(
		context,
		proposalConfig.proposal
	)}:Proposal --sender ${sender} --fork-url ${scdk.rpcUrl} --sig '${proposalConfig.function.replace(
		/'/g,
		''
	)}' -vvvvv ${proposalConfig.arguments?.join(' ')}`;
	let cleanedStdout;
	let cleanedStderr;
	try {
		const { error, stdout, stderr } = await exec(command);
		cleanedStdout = noColor(stdout);
		cleanedStdout = cleanedStdout.slice(
			cleanedStdout.indexOf('Traces:'),
			cleanedStdout.indexOf('SIMULATION COMPLETE')
		);
		cleanedStderr = noColor(stderr);
	} catch (e) {
		console.log(`simulation failed for proposal ${resolve(context, proposal)}`);
		cleanedStdout = noColor((e as any).stdout);
		cleanedStderr = noColor((e as any).stderr);
		return [
			proposalConfig,
			{
				raw_proposal: proposalConfig,
				raw_script: readFileSync(resolve(context, proposalConfig.proposal), 'utf8'),
				simulation_output: cleanedStdout,
				simulation_error_output: cleanedStderr,
				simulation_success: false,
				simulation_transactions: [],
				error: 'Proposal simulation error'
			},
			false
		];
	}
	const foundryExecutionManifest = JSON.parse(
		readFileSync(
			resolve(
				`./broadcast/${basename(proposalConfig.proposal)}/${
					scdk.network_id
				}/dry-run/${proposalConfig.function.slice(0, proposalConfig.function.indexOf('('))}-latest.json`
			),
			'utf8'
		)
	);
	const txs = foundryExecutionManifest.transactions as ForgeTransaction[];
	for (const tx of txs) {
		if (tx.transactionType !== 'CALL') {
			throw new Error(`Unsupported transctionType ${tx.transactionType} in proposal ${proposal}`);
		}
	}
	if (txs.length > 0) {
		const safeKit = await getSafeKit(scdk.provider, sender);
		let safeTx;
		if (txs.length > 1) {
			safeTx = await safeKit.createTransaction({
				safeTransactionData: txs.map(tx => ({
					to: utils.getAddress(tx.transaction.to),
					value: BigInt(tx.transaction.value).toString(),
					data: tx.transaction.data,
					operation: 0
				})),
				options: {
					nonce: proposalConfig.nonce
				}
			});
		} else {
			safeTx = await safeKit.createTransaction({
				safeTransactionData: {
					to: utils.getAddress(txs[0].transaction.to),
					value: BigInt(txs[0].transaction.value).toString(),
					data: txs[0].transaction.data,
					operation: 0
				},
				options: {
					nonce: proposalConfig.nonce
				}
			});
		}

		let estimationRes;

		try {
			estimationRes = await scdk.sak.estimateSafeTransaction(safe.address, safeTx.data);
		} catch (e) {
			return [
				proposalConfig,
				{
					raw_proposal: proposalConfig,
					raw_script: readFileSync(resolve(context, proposalConfig.proposal), 'utf8'),
					simulation_output: cleanedStdout,
					simulation_success: false,
					simulation_transactions: [],
					error: 'Safe estimation error'
				},
				false
			];
		}

		let hasProposed = false;

		if (scdk.shouldWrite && scdk.shouldUpload) {
			if (!delegateExists(safe, proposalConfig.delegate)) {
				throw new Error(`Delegate ${proposalConfig.delegate} not found in safe ${safeName}`);
			}
			const delegateAddress = utils.getAddress(proposalConfig.delegate);

			const signer = scdk.signers[delegateAddress];
			if (signer === undefined) {
				throw new Error(
					`Signer for delegate ${proposalConfig.delegate} not loaded, please provide private key`
				);
			}

			const hash = await safeKit.getTransactionHash(safeTx);

			const safeKitWithDelegateSigner = await getSafeKit(signer, safe.address);

			const signature = await safeKitWithDelegateSigner.signTransactionHash(hash);
			const proposeTxPayload = {
				safeAddress: utils.getAddress(safe.address),
				safeTransactionData: safeTx.data,
				// origin: JSON.stringify({
				// 	url: "https://fleek.ipfs.io/ipfs/QmYr3tfmH78oatVMDTgj1a7qWnWrRuJQRwavn2ArxMhU2E/",
				// 	name: "SafeCD auto proposal"
				// }),
				safeTxHash: hash,
				senderAddress: utils.getAddress(delegateAddress),
				senderSignature: signature.data
			};
			try {
				await scdk.sak.proposeTransaction(proposeTxPayload);
				console.log(`uploaded proposal ${resolve(context, proposal)} with hash ${hash}`);
				hasProposed = true;
			} catch (e) {
				console.error(`Proposal creation error for ${resolve(context, proposal)}`);
				throw e;
			}

			proposalConfig.safeTxHash = hash;
		}

		return [
			proposalConfig,
			{
				raw_proposal: proposalConfig,
				raw_script: readFileSync(resolve(context, proposalConfig.proposal), 'utf8'),
				simulation_output: cleanedStdout,
				simulation_success: true,
				simulation_transactions: txs,
				safe_estimation: estimationRes,
				safe_transaction: safeTx.data
			},
			hasProposed
		];
	} else {
		return [
			proposalConfig,
			{
				raw_proposal: proposalConfig,
				raw_script: readFileSync(resolve(context, proposalConfig.proposal), 'utf8'),
				simulation_output: cleanedStdout,
				simulation_success: true,
				simulation_transactions: txs,
				error: 'No transactions found'
			},
			false
		];
	}
}
