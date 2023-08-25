import SafeApiKit from '@safe-global/api-kit';
import { ethers } from 'ethers';
import { CacheFS } from '../fs/cacheFs';

export interface WriteOperation {
	file: string;
	content: string;
}

export interface SafeCDKit {
	sak: SafeApiKit;
	provider: ethers.providers.Provider;
	signers: { [key: string]: ethers.Signer };
	shouldUpload: boolean;
	shouldWrite: boolean;
	rpcUrl: string;
	safeUrl: string;
	fs: CacheFS;
	network: string;
	network_id: number;
}
