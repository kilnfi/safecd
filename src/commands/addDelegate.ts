import { EthereumProvider } from '@walletconnect/ethereum-provider';
import { Command } from 'commander';
import { ethers } from 'ethers';
import { transactionApis } from '../constants';
import { getSafeApiKit } from '../safe-api/kit';
import { GlobalConfig, GlobalConfigSchema, loadEntity } from '../types';

const { LedgerSigner } = require('@ethersproject/hardware-wallets');
const qrcode = require('qrcode-terminal');

export default function loadCommand(command: Command): void {
	command
		.command('add-delegate')
		.requiredOption('--rpc <char>', 'rpc url')
		.requiredOption('--safe <char>', 'safe address')
		.requiredOption('--label <char>', 'delegate label')
		.requiredOption('--delegate <char>', 'delegate address')
		.requiredOption('--delegator <char>', 'delegate address')
		.option('--ledger <char>', 'ledger derivation path')
		.option('--fireblocks-private-key-path <char>', 'fireblocks private key path')
		.option('--fireblocks-api-key <char>', 'fireblocks api key')
		.option('--fireblocks-vault-account-ids <char>', 'fireblocks vault account id')
		.option('--walletconnect <char>', 'walletconnect')
		.option('--pk <char>', 'private key')
		.action(async options => {
			if (!options.ledger && !options.pk && !options.walletconnect && !options.fireblocksPrivateKeyPath) {
				throw new Error(`Missing ledger or pk`);
			}
			const provider = new ethers.JsonRpcProvider(options.rpc);
			let signer;
			if (options.walletconnect) {
				const provider = await EthereumProvider.init({
					projectId: options.walletconnect, // REQUIRED
					chains: [1],
					showQrModal: false,
					metadata: {
						name: 'safecd-add-safe-delegate',
						description: 'CLI utility to add a delegate to a Safe',
						url: 'https://kiln.fi',
						icons: []
					}
				});
				provider.on('display_uri', (uri: string) => {
					qrcode.generate(uri);
					console.log(`uri: "${uri}"`);
				});
				await provider.connect();
				signer = provider.signer;
			} else if (options.ledger) {
				signer = new LedgerSigner(provider, 'hid', options.ledger);
			} else {
				signer = new ethers.Wallet(options.pk, provider);
			}
			const config: GlobalConfig = loadEntity<GlobalConfig>(GlobalConfigSchema, './safecd.yaml');
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
