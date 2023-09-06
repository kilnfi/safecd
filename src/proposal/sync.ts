import { utils } from 'ethers';
import { Interface } from 'ethers/lib/utils';
import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { promisify } from 'util';
import { getSafeKit } from '../safe-api/kit';
import { ForgeTransaction, Label, Manifest, PopulatedSafe, Proposal, SafeCDKit } from '../types';
import { whereBin } from '../utils/binExists';
import { noColor } from '../utils/noColor';
import { yamlToString } from '../utils/yamlToString';
const exec = promisify(require('child_process').exec);

export async function syncProposals(scdk: SafeCDKit): Promise<boolean> {
	let hasProposedOne = false;
	for (let proposalIdx = 0; proposalIdx < scdk.state.proposals.length; ++proposalIdx) {
		const proposal = scdk.state.proposals[proposalIdx].entity;
		if (proposal.childOf === undefined) {
			const fileName = basename(scdk.state.proposals[proposalIdx].path);
			const prefix = fileName.slice(0, fileName.indexOf('.proposal.yaml'));
			const path = dirname(scdk.state.proposals[proposalIdx].path);
			const proposals = await syncProposal(scdk, proposal, path, prefix, fileName);
			for (const [proposal, manifest, prefixToUse, hasProposed] of proposals) {
				if (manifest !== null) {
					const manifestYaml = yamlToString(manifest);
					console.log(`writting manifest ${resolve(path, `${prefixToUse}.proposal.manifest.yaml`)}`);
					writeFileSync(resolve(path, `${prefixToUse}.proposal.manifest.yaml`), manifestYaml);
					const proposalPath = resolve(path, `${prefixToUse}.proposal.yaml`);
					const proposalIndex = await scdk.state.proposalExists(proposalPath);
					if (proposalIndex >= 0) {
						await scdk.state.writeProposal(proposalIndex, proposal);
					} else {
						await scdk.state.createProposal(proposalPath, proposal);
					}
				}
				console.log(`synced proposal ${resolve(path, fileName)}`);
				if (hasProposed) {
					hasProposedOne = true;
				}
			}
		}
	}
	return hasProposedOne;
}

function delegateExists(safe: PopulatedSafe, address: string): boolean {
	for (const delegate of safe.delegates) {
		if (utils.getAddress(delegate.delegate) === utils.getAddress(address)) {
			return true;
		}
	}
	return false;
}

function harvestAllLabels(scdk: SafeCDKit, customProposalLabels: Label[] | undefined): { [name: string]: string } {
	const res: { [name: string]: string } = {};
	for (const eoa of scdk.state.eoas) {
		res[`EOA:${eoa.entity.name}`] = eoa.entity.address;
	}
	for (const safe of scdk.state.safes) {
		res[`SAFE:${safe.entity.name}`] = safe.entity.address;
	}
	if (scdk.state.config.addressBook) {
		for (const entry of scdk.state.config.addressBook) {
			res[entry.name] = entry.address;
		}
	}
	if (customProposalLabels !== undefined) {
		for (const label of customProposalLabels) {
			res[label.name] = label.address;
		}
	}
	return res;
}

function formatAllLabels(labels: { [name: string]: string }): string {
	const res = [];
	for (const [name, address] of Object.entries(labels)) {
		res.push(address);
		res.push(name);
	}
	return res.join(',');
}

function transformArguments(args: string[], labels: { [name: string]: string }): string[] {
	const res = [];
	for (const arg of args) {
		res.push(
			arg.replace(/\[\[([^\[\]]*)\]\]/gim, (match, p1) => {
				if (labels[p1] === undefined) {
					throw new Error(`Label ${p1} not found`);
				}
				return labels[p1];
			})
		);
	}
	return res;
}

async function isEOA(address: string, scdk: SafeCDKit): Promise<boolean> {
	const code = await scdk.provider.getCode(address);
	return code === '0x';
}

async function syncProposal(
	scdk: SafeCDKit,
	proposalConfig: Proposal,
	context: string,
	prefix: string,
	proposal: string
): Promise<[Proposal, Manifest | null, string, boolean][]> {
	if (proposalConfig.safeTxHash) {
		return [[proposalConfig, null, prefix, false]];
	}
	if (proposalConfig.childOf) {
		const safeAddress = proposalConfig.safe;
		const safe = scdk.state.getSafeByAddress(safeAddress);
		if (safe === null) {
			throw new Error(`Safe ${safeAddress} not found`);
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
						raw_command: '',
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
					const ownerSafe = scdk.state.getSafeByAddress(owner);
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
							safe: ownerSafe.address,
							createChildProposals: true
						};
						let proposalIndex = await scdk.state.proposalExists(
							resolve(context, `${hash}.${ownerIdx}.child.proposal.yaml`)
						);
						if (proposalIndex < 0) {
							scdk.state.createProposal(
								resolve(context, `${hash}.${ownerIdx}.child.proposal.yaml`),
								childProposalConfig
							);
						} else {
							await scdk.state.writeProposal(proposalIndex, childProposalConfig);
						}
						childResults = [
							...childResults,
							...(await syncProposal(
								scdk,
								childProposalConfig,
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
				throw new Error(`Delegate ${proposalConfig.delegate} not found in safe ${safeAddress}`);
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
			if (safe.notifications) {
				proposalConfig.notifications = {};
				if (safe.notifications.slack) {
					proposalConfig.notifications.slack = safe.notifications.slack.channels.map(channel => ({
						channel
					}));
				}
			}
		}

		return [
			[
				proposalConfig,
				{
					safe: safe,
					raw_proposal: proposalConfig,
					raw_script: '',
					raw_command: '',
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
		const safeAddress = proposalConfig.safe;
		const safe = scdk.state.getSafeByAddress(safeAddress);
		if (safe === null) {
			throw new Error(`Safe ${safeAddress} not found`);
		}
		const sender = safe.address;

		const labels = harvestAllLabels(scdk, proposalConfig.labels);

		const command = `${await whereBin('forge')} script ${resolve(
			context,
			proposalConfig.proposal
		)}:Proposal --sender ${sender} --fork-url ${scdk.rpcUrl} --sig '${proposalConfig.function.replace(
			/'/g,
			''
		)}' -vvvvv ${proposalConfig.arguments ? transformArguments(proposalConfig.arguments, labels).join(' ') : ''}`;

		let cleanedStdout;
		let cleanedStderr;
		try {
			process.env.SAFECD_SIMULATION_LABELS = formatAllLabels(labels);
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
						raw_command: command.replace(scdk.rpcUrl, '***'),
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
							raw_command: command.replace(scdk.rpcUrl, '***'),
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
						const ownerSafe = scdk.state.getSafeByAddress(owner);
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
								safe: ownerSafe.address,
								createChildProposals: true
							};
							let proposalIndex = await scdk.state.proposalExists(
								resolve(context, `${hash}.${ownerIdx}.child.proposal.yaml`)
							);
							if (proposalIndex < 0) {
								scdk.state.createProposal(
									resolve(context, `${hash}.${ownerIdx}.child.proposal.yaml`),
									childProposalConfig
								);
							} else {
								await scdk.state.writeProposal(proposalIndex, childProposalConfig);
							}
							childResults = [
								...childResults,
								...(await syncProposal(
									scdk,
									childProposalConfig,
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
					throw new Error(`Delegate ${proposalConfig.delegate} not found in safe ${safeAddress}`);
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
				if (safe.notifications) {
					proposalConfig.notifications = {};
					if (safe.notifications.slack) {
						proposalConfig.notifications.slack = safe.notifications.slack.channels.map(channel => ({
							channel
						}));
					}
				}
			}

			return [
				[
					proposalConfig,
					{
						safe: safe,
						raw_proposal: proposalConfig,
						raw_script: readFileSync(resolve(context, proposalConfig.proposal), 'utf8'),
						raw_command: command.replace(scdk.rpcUrl, '***'),
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
						raw_command: command.replace(scdk.rpcUrl, '***'),
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
