import { SafeMultisigTransactionListResponse } from '@safe-global/api-kit';
import { utils } from 'ethers';
import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { Address, EOA, EOASchema, load, PopulatedSafe, Safe, SafeCDKit, SafeSchema } from '../types';
import { yamlToString } from '../utils/yamlToString';

function hasFinalizedForNonce(txs: SafeMultisigTransactionListResponse['results'], nonce: number): boolean {
	for (const tx of txs) {
		if (tx.nonce === nonce && tx.isExecuted) {
			return true;
		}
	}
	return false;
}

async function cleanupTransactions(scdk: SafeCDKit): Promise<void> {
	if (existsSync('./transactions')) {
		const transactions = readdirSync('./transactions');
		for (const transaction of transactions) {
			const transactionPath = resolve('./transactions', transaction);
			if (existsSync(transactionPath)) {
				const txs = readdirSync(transactionPath);
				for (const tx of txs) {
					const txPath = resolve(transactionPath, tx);
					scdk.fs.remove(txPath);
				}
			}
		}
	}
}

export async function syncSafes(scdk: SafeCDKit): Promise<void> {
	await cleanupTransactions(scdk);
	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: Safe = load<Safe>(scdk, SafeSchema, `./safes/${safeConfig}`);
		const retrievedAddresses = await syncSafe(scdk, safe, `./safes/${safeConfig}`);
		const populatedSafeYaml = yamlToString(retrievedAddresses[retrievedAddresses.length - 1]);
		scdk.fs.write(`./safes/${safeConfig}`, populatedSafeYaml);
		for (const addr of retrievedAddresses.slice(0, retrievedAddresses.length - 1)) {
			if (addr.type === 'eoa') {
				const eoaYaml = yamlToString(addr);
				scdk.fs.write(`./eoas/${addr.address}.yaml`, eoaYaml);
			} else {
				const safeYaml = yamlToString(addr);
				scdk.fs.write(`./safes/${addr.address}.yaml`, safeYaml);
			}
		}
	}
}

async function isEOA(address: string, scdk: SafeCDKit): Promise<boolean> {
	const code = await scdk.provider.getCode(address);
	return code === '0x';
}

async function syncAddresses(addrs: string[], scdk: SafeCDKit): Promise<Address[]> {
	let result: Address[] = [];
	for (const addr of addrs) {
		if (await isEOA(addr, scdk)) {
			if (isMonitoredEOA(addr, scdk)) {
				continue;
			}
			const eoa: EOA = {
				type: 'eoa',
				address: addr,
				name: `eoa-${addr}`,
				description: 'Automatically imported by safecd'
			};
			result.push(eoa);
		} else if (!isMonitoredSafe(addr, scdk)) {
			try {
				const safe = await scdk.sak.getSafeInfo(addr);
				const foundAddresses = await syncSafe(
					scdk,
					{
						address: safe.address,
						name: safe.address,
						type: 'safe'
					} as Safe,
					`./safes/${safe.address}`
				);
				result = [...result, ...foundAddresses];
			} catch (e) {
				// here, an owner is a contract that is not a safe
			}
		}
	}
	return result;
}

function isMonitoredSafe(address: string, scdk: SafeCDKit): boolean {
	if (existsSync('./safes')) {
		const safes = readdirSync('./safes');
		for (const safeConfig of safes) {
			const safe: Safe = load<Safe>(scdk, SafeSchema, `./safes/${safeConfig}`);
			if (utils.getAddress(safe.address) === utils.getAddress(address)) {
				return true;
			}
		}
	}
	return false;
}

function isMonitoredEOA(address: string, scdk: SafeCDKit): boolean {
	if (existsSync('./eoas')) {
		const eoas = readdirSync('./eoas');
		for (const eoa of eoas) {
			const loadedEOA: EOA = load<EOA>(scdk, EOASchema, `./eoas/${eoa}`);
			if (utils.getAddress(loadedEOA.address) === utils.getAddress(address)) {
				return true;
			}
		}
	}
	return false;
}

export interface Transaction {
	safe: string;
	to: string;
	value: string;
	data: string;
	operation: number;
	gasToken: string;
	safeTxGas: number;
	baseGas: number;
	gasPrice: string;
	refundReceiver: string;
	nonce: number;
	executionDate: string | null;
	submissionDate: string;
	modified: string;
	blockNumber: number | null;
	transactionHash: string | null;
	safeTxHash: string;
	executor: string | null;
	isExecuted: false;
	isSuccessful: null;
	ethGasPrice: null;
	maxFeePerGas: null;
	maxPriorityFeePerGas: null;
	gasUsed: null;
	fee: null;
	origin: '{"url": "https://apps-portal.safe.global/tx-builder", "name": "unknown"}';
	dataDecoded: { method: 'multiSend'; parameters: [[Object]] };
	confirmationsRequired: 2;
	confirmations: [
		{
			owner: '0x37d33601b872Cb72ee58c4E2829bf0b36767Ba19';
			submissionDate: '2023-08-23T07:36:04.150185Z';
			transactionHash: null;
			signature: '0x26747f283e90a7147a58b2b5e2de7f72f2efede4733720d7c2a2bba74158cfb36c166f413428fe5bc324eee26363b66ba7b5f7be34ce3c58c89e4a59d2114ce71b';
			signatureType: 'EOA';
		}
	];
	trusted: true;
	signatures: null;
}

async function syncSafeTransactions(
	safe: PopulatedSafe,
	scdk: SafeCDKit
): Promise<SafeMultisigTransactionListResponse['results']> {
	return (await scdk.sak.getMultisigTransactions(safe.address)).results;
}

async function syncSafe(scdk: SafeCDKit, safe: Safe, path: string): Promise<Address[]> {
	const requestedSafe = await scdk.sak.getSafeInfo(safe.address);
	let requestedSafeDelegates = await scdk.sak.getSafeDelegates({
		safeAddress: safe.address,
		limit: '100',
		offset: '0'
	});
	let delegates = [...requestedSafeDelegates.results];
	let idx = 100;
	while (requestedSafeDelegates.next) {
		requestedSafeDelegates = await scdk.sak.getSafeDelegates({
			safeAddress: safe.address,
			limit: '100',
			offset: idx.toString()
		});
		idx += 100;
		delegates = [...delegates, ...requestedSafeDelegates.results];
	}
	const resolvedOwners = await syncAddresses(requestedSafe.owners, scdk);
	const resolvedDelegates = await syncAddresses(
		delegates.map(d => d.delegate),
		scdk
	);
	console.log(`synced ${resolve(path)}`);
	const populatedSafe = {
		...safe,
		owners: requestedSafe.owners.map(utils.getAddress),
		delegates: delegates.map(d => ({
			delegate: utils.getAddress(d.delegate),
			delegator: utils.getAddress(d.delegator),
			label: d.label
		})),
		nonce: requestedSafe.nonce,
		threshold: requestedSafe.threshold,
		version: requestedSafe.version
	};
	const transactions = await syncSafeTransactions(populatedSafe, scdk);
	for (const tx of transactions) {
		if (!tx.trusted) {
			continue;
		}
		if (tx.transactionHash === null && hasFinalizedForNonce(transactions, tx.nonce)) {
			continue;
		}
		const txYaml = yamlToString(tx);
		scdk.fs.write(
			`./transactions/${safe.name}/${tx.nonce.toString().padStart(5, '0')}.${tx.safeTxHash}${
				tx.transactionHash === null ? '.pending.' : '.'
			}yaml`,
			txYaml
		);
	}
	console.log(`synced ${transactions.length} transactions for safe ${safe.address}`);
	return [...resolvedOwners, ...resolvedDelegates, populatedSafe as Address];
}
