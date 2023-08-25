import SafeApiKit from '@safe-global/api-kit';

import Safe, { EthersAdapter } from '@safe-global/protocol-kit';
import { ethers } from 'ethers';

export async function getSafeApiKit(
	provider: ethers.providers.Provider | ethers.Signer,
	txServiceUrl: string
): Promise<SafeApiKit> {
	const ethAdapter = new EthersAdapter({
		ethers,
		signerOrProvider: provider
	});

	const safeService = new SafeApiKit({
		txServiceUrl,
		ethAdapter
	});

	return safeService;
}

export async function getSafeKit(
	provider: ethers.providers.Provider | ethers.Signer,
	safeAddress: string
): Promise<Safe> {
	const ethAdapter = new EthersAdapter({
		ethers,
		signerOrProvider: provider
	});

	return Safe.create({ ethAdapter, safeAddress });
}
