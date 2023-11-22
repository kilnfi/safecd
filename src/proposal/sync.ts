import { utils } from 'ethers';
import { Interface, ParamType } from 'ethers/lib/utils';
import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { promisify } from 'util';
import { getSafeKit } from '../safe-api/kit';
import { ForgeTransaction, Label, Manifest, PopulatedSafe, Proposal, SafeCDKit } from '../types';
import { whereBin } from '../utils/binExists';
import { noColor } from '../utils/noColor';
import { yamlToString } from '../utils/yamlToString';
const safeEval = require('safe-eval');
const exec = promisify(require('child_process').exec);

interface NonceData {
	nonce: number;
	pendingNonce: number;
	auto: number;
}

export async function syncProposals(scdk: SafeCDKit): Promise<boolean> {
	let hasProposedOne = false;
	const proposalIndexes = [];
	for (let proposalIdx = 0; proposalIdx < scdk.state.proposals.length; ++proposalIdx) {
		const proposal = scdk.state.proposals[proposalIdx];
		if (proposal.entity.safeTxHash !== undefined) {
			console.log(`skipping proposal ${proposal.path}`);
			continue;
		}
		if (proposal.entity.childOf === undefined) {
			proposalIndexes.push(proposalIdx);
		}
	}

	const nonces: { [key: string]: NonceData } = {};
	const proposals: { [key: string]: { idx: number; proposal: Proposal; nonce: number }[] } = {};
	// resolve proposals and nonces
	for (const proposalIndex of proposalIndexes) {
		const proposal = scdk.state.proposals[proposalIndex].entity;
		const safe = scdk.state.getSafeByAddress(proposal.safe) as PopulatedSafe;
		if (safe === null) {
			throw new Error(`Safe ${proposal.safe} not found`);
		}
		if (nonces[utils.getAddress(safe.address)] === undefined) {
			const pendingNonce = scdk.state.getHighestProposalNonce(safe);
			const nonce = scdk.state.getHighestExecutedProposalNonce(safe);
			nonces[utils.getAddress(safe.address)] = {
				nonce: nonce != null ? nonce + 1 : 0,
				pendingNonce: pendingNonce != null ? pendingNonce + 1 : 0,
				auto: nonce != null ? nonce + 1 : 0
			};
		}
		if (proposals[utils.getAddress(safe.address)] === undefined) {
			proposals[utils.getAddress(safe.address)] = [];
		}
		let resolvedProposalNonce;
		if (proposal.nonce !== undefined) {
			try {
				resolvedProposalNonce = parseInt(proposal.nonce);
				if (isNaN(resolvedProposalNonce)) {
					throw new Error(`Invalid nonce ${proposal.nonce} for proposal ${proposal.title}`);
				}
			} catch (e) {
				// eval nonce
				try {
					resolvedProposalNonce = safeEval(
						`function getNonce(a,auto,n,nonce,pn,pendingNonce) {return ${proposal.nonce};}`
					)(
						nonces[utils.getAddress(safe.address)].auto,
						nonces[utils.getAddress(safe.address)].auto,
						nonces[utils.getAddress(safe.address)].nonce,
						nonces[utils.getAddress(safe.address)].nonce,
						nonces[utils.getAddress(safe.address)].pendingNonce,
						nonces[utils.getAddress(safe.address)].pendingNonce
					);
					if (
						resolvedProposalNonce == nonces[utils.getAddress(safe.address)].auto &&
						proposal.nonce.includes('a')
					) {
						nonces[utils.getAddress(safe.address)].auto += 1;
					}
				} catch (e) {
					throw new Error(`Invalid nonce expression ${proposal.nonce} for proposal ${proposal.title}`);
				}
			}
			proposals[utils.getAddress(safe.address)].push({
				idx: proposalIndex,
				proposal,
				nonce: resolvedProposalNonce
			});
		}
	}

	for (const proposalIndex of proposalIndexes) {
		const proposal = scdk.state.proposals[proposalIndex].entity;
		const safe = scdk.state.getSafeByAddress(proposal.safe) as PopulatedSafe;
		if (proposal.nonce === undefined) {
			proposals[utils.getAddress(safe.address)].push({
				idx: proposalIndex,
				proposal,
				nonce: nonces[utils.getAddress(safe.address)].auto
			});
			nonces[utils.getAddress(safe.address)].auto += 1;
		}
	}

	for (const safe of Object.keys(proposals)) {
		proposals[safe] = proposals[safe].sort((a, b) => a.nonce - b.nonce);
		for (const proposal of proposals[safe]) {
			const fileName = basename(scdk.state.proposals[proposal.idx].path);
			const prefix = fileName.slice(0, fileName.indexOf('.proposal.yaml'));
			const path = dirname(scdk.state.proposals[proposal.idx].path);
			const proposals = await syncProposal(
				scdk,
				proposal.proposal,
				path,
				prefix,
				fileName,
				proposal.nonce,
				nonces
			);
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

async function isEOA(address: string, scdk: SafeCDKit): Promise<boolean> {
	const code = await scdk.provider.getCode(address);
	return code === '0x';
}

function verifyFunctionNamedParameters(func: string, paramTypes: ParamType[]): void {
	for (const param of paramTypes) {
		if (param.name === '' || param.name === null) {
			throw new Error(`Invalid proposal function signature "${func}": all parameters must be named`);
		}
		if (param.baseType === 'array' && param.arrayChildren.baseType === 'tuple') {
			verifyFunctionNamedParameters(func, param.arrayChildren.components);
		}
		if (param.baseType === 'tuple') {
			verifyFunctionNamedParameters(func, param.components);
		}
	}
}

function isValue(v: any): boolean {
	return typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number';
}

function verifyArguments(param: ParamType, args: any, position: string): void {
	if (args === null || args === undefined) {
		throw new Error(`Invalid proposal arguments: "${position}" argument must be provided`);
	}
	if (param.baseType === 'array') {
		if (!Array.isArray(args)) {
			throw new Error(`Invalid proposal arguments: "${position}" argument must be an array`);
		}
		if (param.arrayLength !== -1 && args.length !== param.arrayLength) {
			throw new Error(
				`Invalid proposal arguments: "${position}" argument must be an array of length ${param.arrayLength}`
			);
		}
		if (param.arrayChildren.baseType === 'array' || param.arrayChildren.baseType === 'tuple') {
			let idx = 0;
			for (const arg of args) {
				verifyArguments(param.arrayChildren, arg, `${position}[${idx}]`);
				++idx;
			}
		} else {
			let idx = 0;
			for (const arg of args) {
				verifyArguments(param.arrayChildren, arg, `${position}[${idx}]`);
				++idx;
			}
		}
	} else if (param.baseType === 'tuple') {
		for (const subParam of param.components) {
			verifyArguments(subParam, args[subParam.name], `${position}.${subParam.name}`);
		}
	} else {
		if (!isValue(args)) {
			throw new Error(
				`Invalid proposal arguments: "${position}" argument must be a valid ${param.baseType} value, got ${args}`
			);
		}
	}
}

function encodeArguments(param: ParamType, args: any, labels: { [key: string]: string }): string {
	let res = '';
	if (param.baseType === 'array') {
		const subElements = [];
		for (const arg of args) {
			subElements.push(encodeArguments(param.arrayChildren, arg, labels));
		}
		res += `[${subElements.join(',')}]`;
	} else if (param.baseType === 'tuple') {
		const subElements = [];
		for (const subParam of param.components) {
			subElements.push(encodeArguments(subParam, args[subParam.name], labels));
		}
		res += `(${subElements.join(',')})`;
	} else {
		if (typeof args === 'string') {
			res = args.replace(/\[\[([^\[\]]*)\]\]/gim, (match, p1) => {
				if (labels[p1] === undefined) {
					throw new Error(`Label ${p1} not found`);
				}
				return labels[p1];
			});
		} else {
			res = args;
		}
		// if (param.baseType === 'string') {
		// 	res = `"${res}"`;
		// }
	}
	return res;
}

async function syncProposal(
	scdk: SafeCDKit,
	proposalConfig: Proposal,
	context: string,
	prefix: string,
	proposal: string,
	nonce: number,
	nonceCache: { [key: string]: NonceData }
): Promise<[Proposal, Manifest | null, string, boolean][]> {
	console.log(`syncing proposal ${resolve(context, proposal)} with nonce=${nonce}`);
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
				operation: 0,
				nonce
			}
			// options: {
			// 	nonce
			// }
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
						if (nonceCache[utils.getAddress(ownerSafe.address)] === undefined) {
							const pendingNonce = scdk.state.getHighestProposalNonce(safe);
							const nonce = scdk.state.getHighestExecutedProposalNonce(safe);
							nonceCache[utils.getAddress(ownerSafe.address)] = {
								nonce: nonce != null ? nonce + 1 : 0,
								pendingNonce: pendingNonce != null ? pendingNonce + 1 : 0,
								auto: nonce != null ? nonce + 1 : 0
							};
						}
						const nonceToUse = nonceCache[utils.getAddress(ownerSafe.address)].auto;
						nonceCache[utils.getAddress(ownerSafe.address)].auto += 1;
						childResults = [
							...childResults,
							...(await syncProposal(
								scdk,
								childProposalConfig,
								context,
								`${hash}.${ownerIdx}.child`,
								`${hash}.${ownerIdx}.child.proposal.yaml`,
								nonceToUse,
								nonceCache
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
			proposalConfig.nonce = safeTx.data.nonce.toString();
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
					raw_proposal: {
						...proposalConfig,
						safeTxHash: hash
					},
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

		const args = [];
		const itf = new Interface([`function ${proposalConfig.function}`]);

		if (proposalConfig.arguments) {
			verifyFunctionNamedParameters(proposalConfig.function, itf.fragments[0].inputs);
			for (const inp of itf.fragments[0].inputs) {
				verifyArguments(inp, proposalConfig.arguments[inp.name], inp.name);
			}
			for (const inp of itf.fragments[0].inputs) {
				args.push(encodeArguments(inp, proposalConfig.arguments[inp.name], labels));
			}
		}

		const command = `${await whereBin('forge')} script ${resolve(
			context,
			proposalConfig.proposal
		)}:Proposal --sender ${sender} --fork-url ${scdk.rpcUrl} --sig '${itf.fragments[0].format()}' -vvvvv ${
			args.length > 0 ? `'${args.join(`' '`)}'` : ''
		}`;

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
						nonce
					}
				});
			} else {
				safeTx = await safeKit.createTransaction({
					safeTransactionData: {
						to: utils.getAddress(txs[0].transaction.to),
						value: BigInt(txs[0].transaction.value).toString(),
						data: txs[0].transaction.data,
						operation: 0,
						nonce
					}
					// options: {
					// 	nonce
					// }
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
							if (nonceCache[utils.getAddress(ownerSafe.address)] === undefined) {
								const pendingNonce = scdk.state.getHighestProposalNonce(safe);
								const nonce = scdk.state.getHighestExecutedProposalNonce(safe);
								nonceCache[utils.getAddress(ownerSafe.address)] = {
									nonce: nonce != null ? nonce + 1 : 0,
									pendingNonce: pendingNonce != null ? pendingNonce + 1 : 0,
									auto: nonce != null ? nonce + 1 : 0
								};
							}
							const nonceToUse = nonceCache[utils.getAddress(ownerSafe.address)].auto;
							nonceCache[utils.getAddress(ownerSafe.address)].auto += 1;
							childResults = [
								...childResults,
								...(await syncProposal(
									scdk,
									childProposalConfig,
									context,
									`${hash}.${ownerIdx}.child`,
									`${hash}.${ownerIdx}.child.proposal.yaml`,
									nonceToUse,
									nonceCache
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
				proposalConfig.nonce = safeTx.data.nonce.toString();
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
						raw_proposal: {
							...proposalConfig,
							safeTxHash: hash
						},
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
