import { Command } from 'commander';
import { ethers } from 'ethers';
import { transactionApis } from '../constants';
import { CacheFS } from '../fs/cacheFs';
import { getSafeApiKit } from '../safe-api/kit';
import { GlobalConfig, GlobalConfigSchema, load } from '../types';
const { LedgerSigner } = require('@ethersproject/hardware-wallets');

export default function loadCommand(command: Command): void {
	command
		.command('add-delegate')
		.requiredOption('--rpc <char>', 'rpc url')
		.requiredOption('--safe <char>', 'safe address')
		.requiredOption('--label <char>', 'delegate label')
		.requiredOption('--delegate <char>', 'delegate address')
		.requiredOption('--delegator <char>', 'delegate address')
		.option('--ledger <char>', 'ledger derivation path')
		.option('--pk <char>', 'private key')
		.action(async options => {
			if (!options.ledger && !options.pk) {
				throw new Error(`Missing ledger or pk`);
			}
			const provider = new ethers.providers.JsonRpcProvider(options.rpc);
			let signer;
			if (options.ledger) {
				signer = new LedgerSigner(provider, 'hid', options.ledger);
			} else {
				signer = new ethers.Wallet(options.pk, provider);
			}
			const fs = new CacheFS();
			const config: GlobalConfig = load<GlobalConfig>(fs, GlobalConfigSchema, './safecd.yaml');
			const safeApiUrl = transactionApis[config.network] as string;
			const sak = await getSafeApiKit(provider, safeApiUrl);

			console.log(
				await sak.addSafeDelegate({
					label: options.label,
					safeAddress: options.safe,
					delegateAddress: options.delegate,
					delegatorAddress: options.delegator,
					signer: signer
				})
			);
		});
}
