import SafeApiKit from '@safe-global/api-kit';

import Safe, { EthersAdapter } from '@safe-global/protocol-kit';
import { ethers } from 'ethers';

export async function getSafeApiKit(
	provider: ethers.Provider | ethers.AbstractSigner,
	txServiceUrl: string
): Promise<SafeApiKit> {
	const ethAdapter = new EthersAdapter({
		ethers,
		signerOrProvider: provider
	});

	const safeService = new SafeApiKit({
		chainId: await ethAdapter.getChainId()
	});

	return safeService;
}

export async function getSafeKit(
	provider: ethers.Provider | ethers.AbstractSigner,
	safeAddress: string
): Promise<Safe> {
	const ethAdapter = new EthersAdapter({
		ethers,
		signerOrProvider: provider
	});

	return Safe.create({ ethAdapter, safeAddress });
}
