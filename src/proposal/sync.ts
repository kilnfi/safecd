import { utils } from 'ethers';
import { Interface } from 'ethers/lib/utils';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, resolve } from 'path';
import { promisify } from 'util';
import { getSafeKit } from '../safe-api/kit';
import {
	EOA,
	EOASchema,
	ForgeTransaction,
	Label,
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
		} else if (stat.isFile() && element.endsWith('.proposal.yaml') && !element.endsWith('.child.proposal.yaml')) {
			const prefix = element.slice(0, element.indexOf('.proposal.yaml'));
			const proposals = await syncProposal(scdk, path, prefix, element);
			for (const [proposal, manifest, prefixToUse, hasProposed] of proposals) {
				if (manifest !== null) {
					const manifestYaml = yamlToString(manifest);
					console.log(`writting manifest ${resolve(path, `${prefixToUse}.proposal.manifest.yaml`)}`);
					writeFileSync(resolve(path, `${prefixToUse}.proposal.manifest.yaml`), manifestYaml);
					const proposalYaml = yamlToString(proposal);
					scdk.fs.write(resolve(path, `${prefixToUse}.proposal.yaml`), proposalYaml);
				}
				console.log(`synced proposal ${resolve(path, element)}`);
				if (hasProposed) {
					hasProposedOne = true;
				}
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

function harvestAllLabels(scdk: SafeCDKit, customProposalLabels: Label[] | undefined): string {
	const eoas = readdirSync('./eoas');
	const safes = readdirSync('./safes');
	const labels = [];
	for (const eoa of eoas) {
		const loadedEOA = load<EOA>(scdk.fs, EOASchema, `./eoas/${eoa}`);
		labels.push(loadedEOA.address);
		labels.push(`EOA:${loadedEOA.name}`);
	}
	for (const safe of safes) {
		const loadedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safe}`);
		labels.push(loadedSafe.address);
		labels.push(`SAFE:${loadedSafe.name}`);
	}
	if (customProposalLabels !== undefined) {
		for (const label of customProposalLabels) {
			labels.push(label.address);
			labels.push(label.name);
		}
	}
	return labels.join(',');
}

async function isEOA(address: string, scdk: SafeCDKit): Promise<boolean> {
	const code = await scdk.provider.getCode(address);
	return code === '0x';
}

async function getSafe(address: string, scdk: SafeCDKit): Promise<PopulatedSafe | null> {
	if (existsSync('./safes')) {
		const safes = readdirSync('./safes');
		for (const safeConfig of safes) {
			const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
			if (utils.getAddress(safe.address) === utils.getAddress(address)) {
				return safe;
			}
		}
	}
	return null;
}

async function syncProposal(
	scdk: SafeCDKit,
	context: string,
	prefix: string,
	proposal: string
): Promise<[Proposal, Manifest | null, string, boolean][]> {
	const proposalConfig: Proposal = load<Proposal>(scdk.fs, ProposalSchema, resolve(context, proposal));
	if (proposalConfig.safeTxHash) {
		return [[proposalConfig, null, prefix, false]];
	}
	if (proposalConfig.childOf) {
		const safeName = proposalConfig.safe;
		const safe = await getSafeByName(scdk, safeName);
		if (safe === null) {
			throw new Error(`Safe ${safeName} not found`);
		}
		const safeKit = await getSafeKit(scdk.provider, safe.address);
		const safeTx = await safeKit.createTransaction({
			safeTransactionData: {
				to: proposalConfig.childOf.safe,
				value: '0',
				data: new Interface(['function approveHash(bytes32 hash)']).encodeFunctionData('approveHash', [
					proposalConfig.childOf.hash
				]),
				operation: 0
			},
			options: {
				nonce: proposalConfig.nonce
			}
		});
		let estimationRes;

		try {
			estimationRes = await scdk.sak.estimateSafeTransaction(safe.address, safeTx.data);
		} catch (e) {
			return [
				[
					proposalConfig,
					{
						safe: safe,
						raw_proposal: proposalConfig,
						raw_script: '',
						simulation_output: '',
						simulation_success: false,
						simulation_transactions: [],
						error: 'Safe estimation error'
					},
					prefix,
					false
				]
			];
		}

		let hasProposed = false;
		const hash = await safeKit.getTransactionHash(safeTx);

		let childResults: [Proposal, Manifest | null, string, boolean][] = [];

		if (proposalConfig.createChildProposals) {
			let ownerIdx = 0;
			for (const owner of safe.owners) {
				if (!(await isEOA(owner, scdk))) {
					const ownerSafe = await getSafe(owner, scdk);
					if (ownerSafe !== null) {
						let found = false;
						for (const delegate of ownerSafe.delegates) {
							if (utils.getAddress(delegate.delegate) === utils.getAddress(proposalConfig.delegate)) {
								found = true;
								break;
							}
						}
						if (!found) {
							continue;
						}
						const childProposalConfig: Proposal = {
							childOf: {
								safe: safe.address,
								hash
							},
							delegate: proposalConfig.delegate,
							title: `Approval of \`${hash}\` on safe \`${safe.address}\``,
							description: `Auto-generated approval of \`${hash}\` on safe \`${safe.address}\`

\`\`\`solidity
Safe(${utils.getAddress(safe.address)}).approveHash(${hash})
\`\`\`

Parent proposal: ${proposalConfig.title}

${proposalConfig.description}
`,
							safe: ownerSafe.name,
							createChildProposals: true
						};
						scdk.fs.write(
							resolve(context, `${hash}.${ownerIdx}.child.proposal.yaml`),
							yamlToString(childProposalConfig)
						);
						childResults = [
							...childResults,
							...(await syncProposal(
								scdk,
								context,
								`${hash}.${ownerIdx}.child`,
								`${hash}.${ownerIdx}.child.proposal.yaml`
							))
						];
					}
				}
				++ownerIdx;
			}
		}

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
			[
				proposalConfig,
				{
					safe: safe,
					raw_proposal: proposalConfig,
					raw_script: '',
					simulation_output: '',
					simulation_success: true,
					simulation_transactions: [],
					safe_estimation: estimationRes,
					safe_transaction: safeTx.data
				},
				prefix,
				hasProposed
			],
			...childResults
		];
	} else if (proposalConfig.proposal && proposalConfig.function) {
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
			process.env.SAFECD_SIMULATION_LABELS = harvestAllLabels(scdk, proposalConfig.labels);
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
				[
					proposalConfig,
					{
						safe: safe,
						raw_proposal: proposalConfig,
						raw_script: readFileSync(resolve(context, proposalConfig.proposal), 'utf8'),
						simulation_output: cleanedStdout,
						simulation_error_output: cleanedStderr,
						simulation_success: false,
						simulation_transactions: [],
						error: 'Proposal simulation error'
					},
					prefix,
					false
				]
			];
		}
		delete process.env.SAFECD_SIMULATION_LABELS;
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
					[
						proposalConfig,
						{
							safe: safe,
							raw_proposal: proposalConfig,
							raw_script: readFileSync(resolve(context, proposalConfig.proposal), 'utf8'),
							simulation_output: cleanedStdout,
							simulation_success: false,
							simulation_transactions: [],
							error: 'Safe estimation error'
						},
						prefix,
						false
					]
				];
			}

			let hasProposed = false;
			const hash = await safeKit.getTransactionHash(safeTx);
			let childResults: [Proposal, Manifest | null, string, boolean][] = [];

			if (proposalConfig.createChildProposals) {
				let ownerIdx = 0;
				for (const owner of safe.owners) {
					if (!(await isEOA(owner, scdk))) {
						const ownerSafe = await getSafe(owner, scdk);
						if (ownerSafe !== null) {
							let found = false;
							for (const delegate of ownerSafe.delegates) {
								if (utils.getAddress(delegate.delegate) === utils.getAddress(proposalConfig.delegate)) {
									found = true;
									break;
								}
							}
							if (!found) {
								continue;
							}
							const childProposalConfig: Proposal = {
								childOf: {
									safe: safe.address,
									hash
								},
								delegate: proposalConfig.delegate,
								title: `Approval of \`${hash}\` on safe \`${safe.address}\``,
								description: `Auto-generated approval of \`${hash}\` on safe \`${safe.address}\`

\`\`\`solidity
Safe(${utils.getAddress(safe.address)}).approveHash(${hash})
\`\`\`

Parent proposal: ${proposalConfig.title}

${proposalConfig.description}
`,
								safe: ownerSafe.name,
								createChildProposals: true
							};
							scdk.fs.write(
								resolve(context, `${hash}.${ownerIdx}.child.proposal.yaml`),
								yamlToString(childProposalConfig)
							);
							childResults = [
								...childResults,
								...(await syncProposal(
									scdk,
									context,
									`${hash}.${ownerIdx}.child`,
									`${hash}.${ownerIdx}.child.proposal.yaml`
								))
							];
						}
					}
					++ownerIdx;
				}
			}

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
				[
					proposalConfig,
					{
						safe: safe,
						raw_proposal: proposalConfig,
						raw_script: readFileSync(resolve(context, proposalConfig.proposal), 'utf8'),
						simulation_output: cleanedStdout,
						simulation_success: true,
						simulation_transactions: txs,
						safe_estimation: estimationRes,
						safe_transaction: safeTx.data
					},
					prefix,
					hasProposed
				],
				...childResults
			];
		} else {
			return [
				[
					proposalConfig,
					{
						safe: safe,
						raw_proposal: proposalConfig,
						raw_script: readFileSync(resolve(context, proposalConfig.proposal), 'utf8'),
						simulation_output: cleanedStdout,
						simulation_success: true,
						simulation_transactions: txs,
						error: 'No transactions found'
					},
					prefix,
					false
				]
			];
		}
	} else {
		throw new Error(
			`Invalid proposal ${resolve(context, proposal)}, should have either childOf or proposal/function`
		);
	}
}
