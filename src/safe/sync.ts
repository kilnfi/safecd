import { SafeMultisigTransactionListResponse } from '@safe-global/api-kit';
import axios from 'axios';
import { utils } from 'ethers';
import { resolve } from 'path';
import { Address, EOA, PopulatedSafe, Safe, SafeCDKit, Transaction } from '../types';

function hasFinalizedForNonce(txs: SafeMultisigTransactionListResponse['results'], nonce: number): boolean {
	for (const tx of txs) {
		if (tx.nonce === nonce && tx.isExecuted) {
			return true;
		}
	}
	return false;
}

export async function syncSafes(scdk: SafeCDKit): Promise<void> {
	for (let safeIdx = 0; safeIdx < scdk.state.safes.length; ++safeIdx) {
		const safe: Safe = scdk.state.safes[safeIdx].entity;
		const retrievedAddresses = await syncSafe(scdk, safe, scdk.state.safes[safeIdx].path);
		await scdk.state.writeSafe(safeIdx, retrievedAddresses[retrievedAddresses.length - 1] as PopulatedSafe);
		for (const addr of retrievedAddresses.slice(0, retrievedAddresses.length - 1)) {
			if (addr.type === 'eoa') {
				if (scdk.state.getEOAByAddress(addr.address) === null) {
					await scdk.state.createEOA(`./eoas/${addr.address}.yaml`, addr as EOA);
				}
			} else {
				if (scdk.state.getSafeByAddress(addr.address) === null) {
					await scdk.state.createSafe(`./safes/${addr.address}.yaml`, addr as PopulatedSafe);
				}
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
	return scdk.state.getSafeByAddress(address) !== null;
}

function isMonitoredEOA(address: string, scdk: SafeCDKit): boolean {
	return scdk.state.getEOAByAddress(address) !== null;
}

async function syncSafeTransactions(
	safe: PopulatedSafe,
	scdk: SafeCDKit
): Promise<SafeMultisigTransactionListResponse['results']> {
	let res = await scdk.sak.getMultisigTransactions(safe.address);
	let results = [...res.results];
	while (res.next) {
		const axiosRes = await axios.get<SafeMultisigTransactionListResponse>(res.next);
		res = axiosRes.data;
		results = [...results, ...res.results];
	}

	return results;
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
		const path = `./transactions/${safe.name}/${tx.nonce.toString().padStart(5, '0')}.${tx.safeTxHash}${
			tx.transactionHash === null ? '.pending.' : '.'
		}yaml`;
		if (scdk.state.transactionByHash[tx.safeTxHash.toLowerCase()] === undefined) {
			await scdk.state.createTransaction(path, tx as Transaction);
		} else {
			const registeredTx = scdk.state.transactions[scdk.state.transactionByHash[tx.safeTxHash.toLowerCase()]];
			if (resolve(registeredTx.path) === resolve(path)) {
				await scdk.state.writeTransaction(
					scdk.state.transactionByHash[tx.safeTxHash.toLowerCase()],
					tx as Transaction
				);
			} else {
				await scdk.state.unbindTransaction(scdk.state.transactionByHash[tx.safeTxHash.toLowerCase()]);
				await scdk.state.createTransaction(path, tx as Transaction);
			}
		}
	}
	console.log(`synced ${transactions.length} transactions for safe ${safe.address}`);
	return [...resolvedOwners, ...resolvedDelegates, populatedSafe as Address];
}
