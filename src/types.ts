import SafeApiKit, { ProposeTransactionProps } from '@safe-global/api-kit';
import { ethers, utils } from 'ethers';
import YAML from 'yaml';
import { z } from 'zod';
import { CacheFS } from './fs/cacheFs';

const ethAddressSchema = z.string().refine(value => utils.isAddress(value), {
	message: 'Provided address is invalid. Please insure you have typed correctly.'
});

export const GlobalConfigSchema = z.object({
	network: z.string()
});

const AddressSchema = z.object({
	type: z.string(),
	name: z.string(),
	address: ethAddressSchema
});

export const SafeSchema = AddressSchema.extend({
	type: z.literal('safe'),
	description: z.string().optional()
});

export const EOASchema = AddressSchema.extend({
	type: z.literal('eoa'),
	description: z.string().optional()
});

export const DelegateSchema = z.object({
	delegate: ethAddressSchema,
	delegator: ethAddressSchema,
	label: z.string()
});

export const PopulatedSafeSchema = SafeSchema.extend({
	owners: z.array(ethAddressSchema),
	delegates: z.array(DelegateSchema),
	threshold: z.number(),
	nonce: z.number(),
	version: z.string()
});

export const ProposalSchema = z.object({
	title: z.string(),
	description: z.string().optional(),
	safe: z.string(),
	delegate: ethAddressSchema,
	proposal: z.string(),
	function: z.string(),
	nonce: z.number().optional(),
	arguments: z.array(z.string()).optional(),
	safeTxHash: z.string().optional()
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type Safe = z.infer<typeof SafeSchema>;
export type EOA = z.infer<typeof EOASchema>;
export type PopulatedSafe = z.infer<typeof PopulatedSafeSchema>;
export type Delegate = z.infer<typeof DelegateSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;

export function load<T>(fs: CacheFS, zo: z.ZodType<T>, path: string): T {
	const rawSafe = YAML.parse(fs.read(path));
	const res = zo.safeParse(rawSafe);
	if (!res.success) {
		console.error(`error${res.error.errors.length > 1 ? 's' : ''} parsing ${path}:`);
		console.error();
		console.error(YAML.stringify(res.error.errors, { lineWidth: 0 }));
		console.error();
		throw new Error(`invalid object file at ${path}`);
	}
	return res.data;
}

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

export interface Manifest {
	simulation_output: string;
	simulation_error_output?: string;
	simulation_success: boolean;
	simulation_transactions: ForgeTransaction[];
	safe_estimation?: any;
	safe_transaction?: ProposeTransactionProps['safeTransactionData'];
	error?: string;
}

export interface ForgeTransaction {
	hash: string;
	transactionType: string;
	contractName: string;
	contractAddress: string;
	function: string;
	arguments: string;
	transaction: {
		type: string;
		from: string;
		to: string;
		gas: string;
		value: string;
		data: string;
		nonce: string;
		accessList: string[];
	};
	additionalContracts: string[];
	isFixedGasLimit: boolean;
}
